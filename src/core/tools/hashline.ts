/**
 * Hashline anchors — every line in a file is prefixed with a short
 * content-derived hash so `edit` can reference lines without the model
 * having to copy their text. Uses a two-part `chunk` scheme (`LOCAL` +
 * `CHUNK`); see `docs/tools.md` for the user-facing rationale.
 *
 * Anchor format: `LINE:LOCAL:CHUNK`.
 *
 * - `LOCAL` hashes the line's own content, whitespace-normalized (trim +
 *   collapse internal runs), so formatter-only edits don't invalidate
 *   anchors. Crucially it does NOT include the line number — a line that
 *   merely moved keeps its local hash, which is what makes shifted-anchor
 *   recovery possible.
 * - `CHUNK` fingerprints the fixed 8-line chunk containing the line, so
 *   edits near a line (same chunk) mark its anchor stale even when the
 *   line itself is untouched.
 *
 * When an anchor goes stale, `findShifted` scans ±15 lines for a line
 * that still validates under the anchor's hashes; a unique match is
 * surfaced to the model as a ready-to-retry fresh anchor.
 *
 * Hashes are FNV-1a 32-bit, encoded as 3 lowercase letters (a–z) each —
 * ~17.5k values per component. The line number in the anchor plus the
 * two independent components keep accidental acceptance of a wrong line
 * far below any practical concern.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export const HASH_LEN = 3;
export const CHUNK_SIZE = 8;
export const SHIFT_SEARCH_RADIUS = 15;

function fnv1aMix(h: number, byte: number): number {
	// >>> 0 keeps the running hash an unsigned 32-bit int; Math.imul is
	// the wrapping 32-bit multiply.
	return Math.imul(h ^ byte, FNV_PRIME) >>> 0;
}

function fnv1a32(data: string): number {
	let h = FNV_OFFSET;
	for (let i = 0; i < data.length; i++) {
		// charCodeAt can exceed 255 for non-ASCII; fold to bytes the same
		// way UTF-8 would spread them is overkill — mixing the full code
		// unit keeps distinct characters distinct, which is all we need.
		h = fnv1aMix(h, data.charCodeAt(i));
	}
	return h;
}

/**
 * Whitespace-normalized FNV-1a fingerprint of a single line: leading and
 * trailing whitespace trimmed, internal whitespace runs collapsed to a
 * single space before hashing. Keeps anchors stable across formatter-only
 * edits while still distinguishing `return x` from `returnx`.
 */
export function lineHash(line: string): number {
	let h = FNV_OFFSET;
	let prevWs = false;
	const trimmed = line.trim();
	for (let i = 0; i < trimmed.length; i++) {
		const code = trimmed.charCodeAt(i);
		if (code === 0x20 || code === 0x09 || code === 0x0b || code === 0x0c) {
			if (!prevWs) {
				h = fnv1aMix(h, 0x20);
				prevWs = true;
			}
		} else {
			h = fnv1aMix(h, code);
			prevWs = false;
		}
	}
	return h;
}

/** Encode a 32-bit hash as `len` lowercase letters, one per byte region. */
export function encodeHash(hashValue: number, len: number = HASH_LEN): string {
	let out = "";
	for (let i = 0; i < len; i++) {
		out += String.fromCharCode(97 + (((hashValue >>> (i * 8)) >>> 0) % 26));
	}
	return out;
}

/**
 * Fingerprint of the fixed-size chunk containing `lineIdx` (0-based):
 * every line hash in the chunk mixed together. Any edit inside the chunk
 * changes the fingerprint of all its lines.
 */
export function chunkFingerprint(lines: string[], lineIdx: number): string {
	const chunkStart = Math.floor(lineIdx / CHUNK_SIZE) * CHUNK_SIZE;
	const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, lines.length);
	let combined = fnv1a32("chunk");
	for (let i = chunkStart; i < chunkEnd; i++) {
		combined = Math.imul(combined ^ lineHash(lines[i] ?? ""), FNV_PRIME) >>> 0;
	}
	return encodeHash(combined);
}

/**
 * Compute `[local, chunk]` anchor components for every line of `lines`,
 * in source order. Chunk fingerprints are computed once per chunk.
 */
export function computeHashesForLines(lines: string[]): Array<[string, string]> {
	const numChunks = Math.ceil(lines.length / CHUNK_SIZE);
	const chunkFps: string[] = new Array(numChunks);
	for (let c = 0; c < numChunks; c++) {
		const start = c * CHUNK_SIZE;
		const end = Math.min(start + CHUNK_SIZE, lines.length);
		let combined = fnv1a32("chunk");
		for (let i = start; i < end; i++) {
			combined = Math.imul(combined ^ lineHash(lines[i] ?? ""), FNV_PRIME) >>> 0;
		}
		chunkFps[c] = encodeHash(combined);
	}
	const out: Array<[string, string]> = new Array(lines.length);
	for (let i = 0; i < lines.length; i++) {
		out[i] = [encodeHash(lineHash(lines[i] ?? "")), chunkFps[Math.floor(i / CHUNK_SIZE)] ?? ""];
	}
	return out;
}

/** Convenience wrapper over `computeHashesForLines` for raw file content. */
export function computeLineHashes(content: string): Array<[string, string]> {
	return computeHashesForLines(content.split("\n"));
}

/** Render `LINE:LOCAL:CHUNK` for a 1-based line. */
export function renderAnchor(lineNumber: number, hashes: [string, string]): string {
	return `${lineNumber}:${hashes[0]}:${hashes[1]}`;
}

/**
 * Produce the gutter text the model sees: `LINE:LOCAL:CHUNK→content`.
 * The arrow separator is never legal leading whitespace in source, so a
 * tab-indented file's real tabs stay unambiguous against the gutter.
 */
export function renderAnchoredLine(lineNumber: number, hashes: [string, string], content: string): string {
	return `${renderAnchor(lineNumber, hashes)}→${content}`;
}

export interface ParsedAnchor {
	line: number;
	localHash: string;
	/** Absent when the model passed a truncated `LINE:LOCAL` form. */
	chunkHash?: string;
}

const ANCHOR_RE = /^(\d+):([a-z]+)(?::([a-z]+))?$/;
/** Hash-only form models drop when they omit the line number: `LOCAL:CHUNK`. */
const HASH_SUFFIX_RE = /^([a-z]+):([a-z]+)$/;

/**
 * Drop a pasted gutter's content after the arrow. Accepts both the real
 * `→` separator and the ASCII `->` models sometimes type instead.
 */
export function stripAnchorGutter(anchor: string): string {
	const uni = anchor.indexOf("→");
	if (uni !== -1) return anchor.slice(0, uni).trim();
	const ascii = anchor.indexOf("->");
	if (ascii !== -1) return anchor.slice(0, ascii).trim();
	return anchor.trim();
}

/**
 * Parse `LINE:LOCAL` or `LINE:LOCAL:CHUNK` into its parts. Returns `null`
 * for garbage — the caller decides how to surface that.
 *
 * Models routinely paste the whole gutter (`22:abc:rst→content`) instead
 * of just the anchor, so anything from the arrow separator onward is
 * dropped before parsing. `→` / `->` can never appear inside a valid anchor.
 */
export function parseAnchor(anchor: string): ParsedAnchor | null {
	const head = stripAnchorGutter(anchor);
	const match = ANCHOR_RE.exec(head);
	if (!match) return null;
	const [, lineStr, local, chunk] = match;
	return {
		line: Number.parseInt(lineStr ?? "", 10),
		localHash: local ?? "",
		...(chunk ? { chunkHash: chunk } : {}),
	};
}

/**
 * Recover a full anchor when the model dropped the line number and sent
 * only `LOCAL:CHUNK` (or that suffix pasted with a gutter arrow). Accepts
 * the match only when exactly one line in `hashes` carries that pair —
 * never guesses between duplicates.
 */
export function recoverAnchorBySuffix(suffix: string, hashes: Array<[string, string]>): ParsedAnchor | null {
	const head = stripAnchorGutter(suffix);
	const match = HASH_SUFFIX_RE.exec(head);
	if (!match) return null;
	const local = match[1] ?? "";
	const chunk = match[2] ?? "";
	const hits: number[] = [];
	for (let i = 0; i < hashes.length; i++) {
		const [l, c] = hashes[i] ?? ["", ""];
		if (l === local && c === chunk) hits.push(i + 1);
	}
	if (hits.length !== 1) return null;
	return { line: hits[0]!, localHash: local, chunkHash: chunk };
}

export type ResolvedAnchor = {
	anchor: ParsedAnchor;
	/** True when the model omitted the line number and we recovered it. */
	recoveredFromSuffix: boolean;
};

/**
 * Parse a model-supplied anchor string against the current file hashes.
 * Tries the normal `LINE:LOCAL:CHUNK` form first; if that fails, uniquely
 * recovers from a hash-only `LOCAL:CHUNK` suffix. Returns `null` when
 * neither path yields an unambiguous anchor.
 */
export function resolveAnchor(anchorStr: string, hashes: Array<[string, string]>): ResolvedAnchor | null {
	const parsed = parseAnchor(anchorStr);
	if (parsed) return { anchor: parsed, recoveredFromSuffix: false };
	const recovered = recoverAnchorBySuffix(anchorStr, hashes);
	if (recovered) return { anchor: recovered, recoveredFromSuffix: true };
	return null;
}

export type AnchorValidation = "valid" | "stale" | "out_of_range";

/**
 * Validate a parsed anchor against the current file. A truncated anchor
 * (no chunk component) is treated as stale rather than silently weakening
 * validation to content-only semantics.
 */
export function validateAnchor(anchor: ParsedAnchor, hashes: Array<[string, string]>): AnchorValidation {
	const idx = anchor.line - 1;
	if (idx < 0 || idx >= hashes.length) return "out_of_range";
	const [local, chunk] = hashes[idx] ?? ["", ""];
	if (anchor.localHash !== local) return "stale";
	if (!anchor.chunkHash || anchor.chunkHash !== chunk) return "stale";
	return "valid";
}

export type ShiftResult = { kind: "found"; newLine: number } | { kind: "ambiguous"; candidates: number[] } | null;

/**
 * Search ±`radius` lines around a stale anchor for a line whose local
 * (content) hash still matches. Exactly one hit means the content simply
 * moved — the caller can hand the model a ready-made fresh anchor.
 *
 * The anchor's chunk component is NOT checked against candidates. The very
 * edit that shifted the line (an insertion above) also changed every chunk
 * fingerprint, so requiring the old chunk to match would make recovery almost
 * never fire. A unique content match within the window is strong enough
 * evidence, and the model's retry is revalidated against the full fresh
 * anchor anyway.
 */
export function findShifted(
	anchor: ParsedAnchor,
	hashes: Array<[string, string]>,
	radius: number = SHIFT_SEARCH_RADIUS,
): ShiftResult {
	const origIdx = anchor.line - 1;
	const start = Math.max(0, origIdx - radius);
	const end = Math.min(origIdx + radius + 1, hashes.length);
	const candidates: number[] = [];
	for (let idx = start; idx < end; idx++) {
		if (idx === origIdx) continue;
		if ((hashes[idx] ?? ["", ""])[0] !== anchor.localHash) continue;
		candidates.push(idx + 1);
	}
	if (candidates.length === 1) return { kind: "found", newLine: candidates[0]! };
	if (candidates.length > 1) return { kind: "ambiguous", candidates };
	return null;
}

/**
 * Format a fresh-anchor snippet for error replies — used by `edit` when
 * a stale or missing anchor needs the model to retry. Returns lines with
 * their actual current anchors, so the model can copy them straight back
 * into a follow-up call without re-`read`ing the file.
 */
export function formatAnchorSnippet(
	lines: string[],
	hashes: Array<[string, string]>,
	centre: number,
	radius: number,
): string {
	const lo = Math.max(0, centre - radius);
	const hi = Math.min(lines.length, centre + radius + 1);
	const out: string[] = [];
	for (let i = lo; i < hi; i++) {
		out.push(renderAnchoredLine(i + 1, hashes[i] ?? ["", ""], lines[i] ?? ""));
	}
	return out.join("\n");
}
