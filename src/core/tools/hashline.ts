/**
 * Hashline anchors — every line in a file is prefixed with a short
 * content-derived hash so `edit` can reference lines without the model
 * having to copy their text. Same scheme `xai-org/grok-build` uses; see
 * `docs/tools.md` for the user-facing rationale.
 *
 * The hash is mixed with the 1-based line number so two identical lines
 * on different lines still get different anchors (otherwise the model
 * could never pick one). A short secondary hash keyed on the previous
 * line is appended only when it actually disambiguates — that's why
 * most gutters you see will be `LINE:HASH→content`, with the secondary
 * `:HH` slice showing up only when two neighbouring lines collide.
 *
 * Hash size: primary 24 bits (6 hex), secondary 12 bits (3 hex). The
 * number-mixer keeps accidental collisions < 10⁻³ even in adversarial
 * 2k-line inputs; bigger gutters just cost more tokens.
 */

import { createHash } from "node:crypto";

const PRIMARY_HEX_LEN = 6;
const SECONDARY_HEX_LEN = 3;

/** Two-line window over `lines`, materialised once so callers don't redo it. */
function previousLines(lines: string[]): string[] {
	const out: string[] = new Array(lines.length);
	out[0] = "";
	for (let i = 1; i < lines.length; i++) {
		out[i] = lines[i - 1] ?? "";
	}
	return out;
}

function sha1Hex(input: string, len: number): string {
	return createHash("sha1").update(input).digest("hex").slice(0, len);
}

/**
 * Compute the anchor hashes for every line in `content` (split on `\n`,
 * without splitting). Returns a parallel array: `[primary, secondary]`
 * for each line, in source order. The secondary is the same length as
 * the primary, but callers typically only print `len(SECONDARY_HEX_LEN)`
 * of it — `formatLineGutter` does the right thing.
 */
export function computeLineHashes(content: string): Array<[string, string]> {
	const lines = content.split("\n");
	const prevs = previousLines(lines);
	const out: Array<[string, string]> = new Array(lines.length);
	for (let i = 0; i < lines.length; i++) {
		const lineNo = i + 1;
		const line = lines[i] ?? "";
		const prev = prevs[i] ?? "";
		const primary = sha1Hex(`${lineNo}\0${line}`, PRIMARY_HEX_LEN);
		const secondary = sha1Hex(`${lineNo}\0${prev}\0${line}`, SECONDARY_HEX_LEN);
		out[i] = [primary, secondary];
	}
	return out;
}

/**
 * Hash a single line directly. Mostly useful in tests; `execRead` and
 * `execGrep` go through `computeLineHashes` so the result lines up with
 * `formatLineGutter`.
 */
export function hash(lineNumber1Based: number, content: string, prevContent?: string): [string, string] {
	const prev = prevContent ?? "";
	return [
		sha1Hex(`${lineNumber1Based}\0${content}`, PRIMARY_HEX_LEN),
		sha1Hex(`${lineNumber1Based}\0${prev}\0${content}`, SECONDARY_HEX_LEN),
	];
}

export interface GutterInput {
	lineNumber: number;
	content: string;
	prevContent?: string;
}

/**
 * Produce the gutter text the model sees: `<LINE>:<HASH>[:HH]→<content>`.
 * The secondary `:HH` slice is omitted when it equals the primary's first
 * `SECONDARY_HEX_LEN` chars — that keeps most lines short while still
 * letting two neighbouring identical lines be told apart.
 */
export function formatLineGutter({ lineNumber, content, prevContent }: GutterInput): string {
	const [primary, secondary] = hash(lineNumber, content, prevContent);
	if (secondary === primary.slice(0, SECONDARY_HEX_LEN)) {
		return `${lineNumber}:${primary}→${content}`;
	}
	return `${lineNumber}:${primary}:${secondary}→${content}`;
}

export interface ParsedAnchor {
	line: number;
	primaryHash: string;
	/** Only present when the model passed a full `LINE:HASH:HH` form. */
	secondaryHash?: string;
}

const ANCHOR_RE = /^(\d+):([0-9a-f]+)(?::([0-9a-f]+))?$/;

/**
 * Build the secondary-hash suffix that `formatLineGutter` would print
 * for the same line. Used by `grep`, which only knows the line content
 * (and the previous line) — the primary hash it can call `hash()` for,
 * but the secondary suffix needs to be byte-identical to what `read`
 * would have printed for the model to copy-paste it back. Returns "" if
 * the suffix would be elided.
 */
export function secondarySuffix(lineNumber: number, content: string, prevContent?: string): string {
	const prev = prevContent ?? "";
	const primary = sha1Hex(`${lineNumber}\0${content}`, PRIMARY_HEX_LEN);
	const secondary = sha1Hex(`${lineNumber}\0${prev}\0${content}`, SECONDARY_HEX_LEN);
	return secondary === primary.slice(0, SECONDARY_HEX_LEN) ? "" : secondary;
}

/**
 * Parse `<line>:<hash>` or `<line>:<hash>:<secondary>` into its parts.
 * Returns `null` for garbage — the caller decides whether to surface
 * that as an `AnchorNotFound` or a more specific error. The hash chars
 * are kept lowercase; the model will usually echo what `read` returned.
 */
export function parseAnchor(anchor: string): ParsedAnchor | null {
	const match = ANCHOR_RE.exec(anchor);
	if (!match) return null;
	const [, lineStr, primary, secondary] = match;
	return {
		line: Number.parseInt(lineStr ?? "", 10),
		primaryHash: primary ?? "",
		secondaryHash: secondary,
	};
}

/**
 * Format a fresh-anchor snippet for error replies — used by `edit` when
 * a stale or missing anchor needs the model to retry. Returns lines
 * numbered with their actual current hashes, so the model can copy them
 * straight back into a follow-up call without re-`read`ing the file.
 */
export function formatAnchorSnippet(lines: string[], centre: number, radius: number): string {
	const lo = Math.max(0, centre - radius);
	const hi = Math.min(lines.length, centre + radius + 1);
	const out: string[] = [];
	for (let i = lo; i < hi; i++) {
		out.push(formatLineGutter({ lineNumber: i + 1, content: lines[i] ?? "", prevContent: lines[i - 1] }));
	}
	return out.join("\n");
}
