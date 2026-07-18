/**
 * File tools — `read` (with hashline anchors), `write`, and `edit`
 * (anchor-based `ops[]` with `replace`/`insert_after`/`write`). All paths
 * resolve against the agent's cwd via resolvePath.
 */

import { constants } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import type { AppConfig } from "../config.ts";
import {
	computeHashesForLines,
	findShifted,
	formatAnchorSnippet,
	recoverAnchorBySuffix,
	renderAnchoredLine,
	resolveAnchor,
	stripAnchorGutter,
	validateAnchor,
} from "./hashline.ts";
import { getCachedFile, invalidateCachedFile } from "./hashline-cache.ts";
import { findFilesByBasename } from "./search.ts";
import { formatSize, resolvePath, type ToolResult } from "./shared.ts";

function isEnoent(err: unknown): boolean {
	return (err as { code?: string })?.code === "ENOENT";
}

/**
 * When the requested path is missing, run `glob` by basename under the hood
 * and attach real hits so the model can retry `read`/`edit` without starting
 * its own search loop. No guessed prefixes — only what the search returns.
 */
async function fileNotFoundResult(filePath: string, cwd: string, config: AppConfig): Promise<ToolResult> {
	const hits = await findFilesByBasename(basename(filePath), cwd, config);
	if (hits.length === 0) {
		return { content: `File not found: ${filePath}`, isError: true };
	}
	const list = hits.map((h) => `- ${h}`).join("\n");
	return {
		content:
			`File not found: ${filePath}\n` +
			`Found by name (use one of these paths with read/edit — do not call glob):\n${list}`,
		isError: true,
	};
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function execRead(args: Record<string, unknown>, cwd: string, config: AppConfig): Promise<ToolResult> {
	const filePath = String(args.path ?? "");
	if (!filePath) return { content: "path is required", isError: true };
	const offset = typeof args.offset === "number" ? args.offset : undefined;
	const limit = typeof args.limit === "number" ? args.limit : undefined;
	const absolutePath = resolvePath(filePath, cwd);

	try {
		await access(absolutePath, constants.R_OK);
	} catch (err) {
		if (isEnoent(err)) return fileNotFoundResult(filePath, cwd, config);
		throw err;
	}

	const mimeType = IMAGE_MIME_TYPES[extname(absolutePath).toLowerCase()];
	if (mimeType) {
		const stats = await stat(absolutePath);
		if (stats.size > MAX_IMAGE_BYTES) {
			return {
				content: `Image too large to read (${formatSize(stats.size)}, max ${formatSize(MAX_IMAGE_BYTES)}): ${filePath}`,
				isError: true,
			};
		}
		const buffer = await readFile(absolutePath);
		return {
			content: `[Image: ${filePath} (${mimeType}, ${formatSize(stats.size)}) — shown in the next message]`,
			imageDataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
		};
	}

	// Served from the LRU when the file was already read this session —
	// the second read in an `read → edit` round trip skips the disk and
	// the per-line hashing. Mtime on the entry is re-checked on hit so a
	// concurrent editor invalidates the cache for us.
	const cached = await getCachedFile(absolutePath);
	const allLines = cached.lines;

	const startLine = offset ? Math.max(0, offset - 1) : 0;
	if (startLine >= allLines.length) {
		return { content: `Offset ${offset} is beyond end of file (${allLines.length} lines total)`, isError: true };
	}

	const endLine = limit ? Math.min(startLine + limit, allLines.length) : allLines.length;
	let selectedLines = allLines.slice(startLine, endLine);

	// Truncate if too many lines
	if (selectedLines.length > config.maxToolOutputLines) {
		selectedLines = selectedLines.slice(0, config.maxToolOutputLines);
	}

	// Hashline gutter: each line is prefixed with `LINE:LOCAL:CHUNK→content`
	// so `edit` can reference lines without the model having to copy their
	// text. The arrow separator is never legal leading whitespace in source,
	// so a tab-indented file's real tabs stay unambiguous against the gutter.
	// See `hashline.ts` for the anchor scheme.
	const numbered = selectedLines
		.map((line, i) => renderAnchoredLine(startLine + i + 1, cached.hashes[startLine + i] ?? ["", ""], line))
		.join("\n");

	// Build continuation hint
	const totalLines = allLines.length;
	const shownEnd = startLine + selectedLines.length;
	let hint = "";
	if (shownEnd < totalLines) {
		hint = `\n\n[Showing lines ${startLine + 1}-${shownEnd} of ${totalLines}. Use offset=${shownEnd + 1} to continue.]`;
	}

	return { content: numbered + hint };
}

export async function execWrite(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
	const filePath = String(args.path ?? "");
	if (!filePath) return { content: "path is required", isError: true };
	const content = String(args.content ?? "");
	const absolutePath = resolvePath(filePath, cwd);

	let oldContent: string | null = null;
	try {
		oldContent = await readFile(absolutePath, "utf-8");
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}

	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content, "utf-8");
	// Drop any cached read so the next read/edit sees the new content.
	invalidateCachedFile(absolutePath);

	const newLines = content.split("\n");
	const dupWarning = duplicateRunWarning(newLines);
	const warn = dupWarning ? `\nWarning: ${dupWarning}` : "";

	if (oldContent === null) {
		return { content: `Created ${filePath} (${newLines.length} lines, ${content.length} bytes).${warn}` };
	}
	if (oldContent === content) {
		return { content: `Wrote ${filePath} — content is identical to what was already on disk.${warn}` };
	}
	// Echo the change as a diff rather than a byte count. A full rewrite is
	// where the model most often reproduces stale or corrupted content from
	// its context; a visible diff of what actually changed catches that
	// immediately, where "wrote N bytes" hides it.
	//
	// The trailing newline is diffed out-of-band: models drop or add it all
	// the time, and letting it into the line diff destroys the common-suffix
	// match — every trailing line then shows as -/+ noise drowning the real
	// change.
	const oldDiffLines = oldContent.split("\n");
	const hadTrailingNl = oldDiffLines[oldDiffLines.length - 1] === "" && oldDiffLines.length > 1;
	const hasTrailingNl = newLines[newLines.length - 1] === "" && newLines.length > 1;
	if (hadTrailingNl) oldDiffLines.pop();
	const newDiffLines = hasTrailingNl ? newLines.slice(0, -1) : newLines;
	let nlNote = "";
	if (hadTrailingNl !== hasTrailingNl) {
		nlNote = hasTrailingNl ? "\nNote: trailing newline added." : "\nNote: trailing newline removed — the file no longer ends with a newline.";
	}
	const diff = formatWriteDiff(oldDiffLines, newDiffLines);
	return { content: `Overwrote ${filePath} (${newLines.length} lines). Diff vs previous content:\n\n${diff}${nlNote}${warn}` };
}

const MAX_DIFF_LINES = 80;

/**
 * Minimal line diff for the `write` echo: trim the common prefix and
 * suffix, show what's left as `-`/`+` blocks with one context line on
 * each side. Not an LCS — a full rewrite usually changes one region, and
 * when it doesn't, the (truncated) coarse diff still shows the shape of
 * the change.
 */
function formatWriteDiff(oldLines: string[], newLines: string[]): string {
	let prefix = 0;
	const maxPrefix = Math.min(oldLines.length, newLines.length);
	while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) prefix++;
	let suffix = 0;
	const maxSuffix = Math.min(oldLines.length, newLines.length) - prefix;
	while (suffix < maxSuffix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) {
		suffix++;
	}
	const out: string[] = [];
	if (prefix > 0) out.push(`  ${oldLines[prefix - 1]}`);
	const removed = oldLines.slice(prefix, oldLines.length - suffix);
	const added = newLines.slice(prefix, newLines.length - suffix);
	let budget = MAX_DIFF_LINES;
	for (const line of removed) {
		if (budget-- <= 0) break;
		out.push(`- ${line}`);
	}
	for (const line of added) {
		if (budget-- <= 0) break;
		out.push(`+ ${line}`);
	}
	if (budget < 0) out.push(`⋯ (diff truncated: ${removed.length} removed, ${added.length} added in total)`);
	if (suffix > 0) out.push(`  ${newLines[newLines.length - suffix]}`);
	return out.join("\n");
}

/**
 * Detect runs of consecutive byte-identical non-blank lines — the classic
 * symptom of a botched edit or a rewrite that copied corrupted context
 * (e.g. the same comment pasted twice). Surfaced as a warning, never an
 * error: legitimate duplicates exist, but they're rare enough that a nudge
 * to double-check is worth it.
 */
function duplicateRunWarning(lines: string[]): string | null {
	const runs: string[] = [];
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.trim() === "" || line !== lines[i - 1]) continue;
		let end = i;
		while (end + 1 < lines.length && lines[end + 1] === line) end++;
		runs.push(`lines ${i}-${end + 1} ("${line.trim().slice(0, 60)}")`);
		i = end;
	}
	if (runs.length === 0) return null;
	return `file contains consecutive identical lines — ${runs.join("; ")}. If unintentional, remove the duplicates.`;
}

export async function execEdit(args: Record<string, unknown>, cwd: string, config: AppConfig): Promise<ToolResult> {
	const filePath = String(args.path ?? "");
	if (!filePath) return { content: "path is required", isError: true };

	const absolutePath = resolvePath(filePath, cwd);

	const resolved = resolveOps(args, filePath);
	if (!resolved.ok) return { content: resolved.error, isError: true };
	const ops = resolved.ops;

	// Read once; hashlines are computed against the snapshot the model last
	// saw, so applying ops bottom-up can't shift any anchor that hasn't been
	// validated yet. A `write` op short-circuits everything else. Served
	// from the LRU when this file was already read in the same session.
	try {
		await access(absolutePath, constants.R_OK | constants.W_OK);
	} catch (err) {
		if (isEnoent(err)) return fileNotFoundResult(filePath, cwd, config);
		throw err;
	}
	const cached = await getCachedFile(absolutePath);
	const lines = cached.lines;
	const hashes = cached.hashes;

	const writeOp = ops.find((o) => o.kind === "write");
	if (writeOp) {
		const content = (writeOp as { kind: "write"; content: string }).content;
		await writeFile(absolutePath, content, "utf-8");
		invalidateCachedFile(absolutePath);
		const dupWarning = duplicateRunWarning(content.split("\n"));
		return { content: `Updated file ${filePath}.${dupWarning ? `\nWarning: ${dupWarning}` : ""}` };
	}

	// Bucket every non-write op into a typed record against the *pre-edit*
	// file. Validation here is what catches "stale anchor", "anchor not
	// found", "ambiguous anchor" and "range overlap" before anything is
	// written — the model gets the fresh-anchor snippet it needs to retry.
	const bucketResult = bucketOps(ops, lines, hashes, filePath);
	if (!bucketResult.ok) return bucketResult.result;

	// Apply bottom-up so each splice stays inside the original line
	// numbering. `replace` rewrites lines[a..b], `insert_after` splices
	// new lines after lines[a]. Either way earlier line numbers don't
	// shift, which is the whole reason anchored edits can be batched.
	const mutated = lines.slice();
	const sorted = bucketResult.ops.slice().sort((a, b) => {
		const la = a.kind === "insert" ? a.line : a.lineStart;
		const lb = b.kind === "insert" ? b.line : b.lineStart;
		if (la !== lb) return lb - la;
		// Tie: an insert_after anchored on the first line of a replace range
		// must be applied before the replace, otherwise a multi-line
		// replacement shifts the insertion point into its own middle.
		if (a.kind === "insert" && b.kind === "replace") return -1;
		if (a.kind === "replace" && b.kind === "insert") return 1;
		return 0;
	});
	for (const op of sorted) {
		if (op.kind === "replace") {
			mutated.splice(op.lineStart, op.lineEnd - op.lineStart + 1, ...op.textLinesToInsert);
		} else {
			mutated.splice(op.line + 1, 0, ...op.textLinesToInsert);
		}
	}

	await writeFile(absolutePath, mutated.join("\n"), "utf-8");
	invalidateCachedFile(absolutePath);
	// Echo the edited regions back with fresh anchors. Without this the
	// model is flying blind after every edit — it builds the next op on
	// what it *believes* the file now looks like, and a misplaced insert
	// or a forgotten end_anchor goes unnoticed until a full re-read. The
	// snippet makes the damage (or success) visible immediately and hands
	// over ready-to-use anchors for the follow-up edit.
	const snippet = postEditSnippet(bucketResult.ops, mutated);
	const dupWarning = duplicateRunWarning(mutated);
	const noteLines = bucketResult.notes.map((n) => `Note: ${n}`);
	if (dupWarning) noteLines.push(`Warning: ${dupWarning}`);
	const notes = noteLines.join("\n");
	return {
		content: `Updated ${ops.length} block(s) in ${filePath}.${notes ? `\n${notes}` : ""} Result (with fresh anchors):\n\n${snippet}`,
	};
}

const SNIPPET_CONTEXT_LINES = 2;
const MAX_SNIPPET_LINES = 60;

/**
 * Render the post-edit regions with fresh anchors. Each op's final
 * position in the mutated file is its original position shifted by the
 * line-count deltas of the ops above it; overlapping context windows are
 * merged so adjacent edits read as one block.
 */
function postEditSnippet(ops: BucketedOp[], mutated: string[]): string {
	const freshHashes = computeHashesForLines(mutated);
	// Ascending file order, accumulating the shift each op causes for
	// everything below it.
	const asc = ops.slice().sort((a, b) => {
		const la = a.kind === "insert" ? a.line : a.lineStart;
		const lb = b.kind === "insert" ? b.line : b.lineStart;
		return la - lb;
	});
	let delta = 0;
	const regions: Array<[number, number]> = [];
	for (const op of asc) {
		let start: number;
		let inserted: number;
		let removed: number;
		if (op.kind === "replace") {
			start = op.lineStart + delta;
			inserted = op.textLinesToInsert.length;
			removed = op.lineEnd - op.lineStart + 1;
		} else {
			start = op.line + 1 + delta;
			inserted = op.textLinesToInsert.length;
			removed = 0;
		}
		// A pure deletion has no inserted lines to show — the region
		// degrades to the context around the seam.
		const end = inserted > 0 ? start + inserted - 1 : start;
		regions.push([
			Math.max(0, start - SNIPPET_CONTEXT_LINES),
			Math.min(mutated.length - 1, end + SNIPPET_CONTEXT_LINES),
		]);
		delta += inserted - removed;
	}
	// Merge windows that touch or overlap.
	const merged: Array<[number, number]> = [];
	for (const r of regions) {
		const last = merged[merged.length - 1];
		if (last && r[0] <= last[1] + 1) {
			last[1] = Math.max(last[1], r[1]);
		} else {
			merged.push([r[0], r[1]]);
		}
	}
	const out: string[] = [];
	let budget = MAX_SNIPPET_LINES;
	for (let i = 0; i < merged.length && budget > 0; i++) {
		if (i > 0) out.push("⋯");
		const [lo, hi] = merged[i]!;
		for (let line = lo; line <= hi && budget > 0; line++, budget--) {
			out.push(renderAnchoredLine(line + 1, freshHashes[line] ?? ["", ""], mutated[line] ?? ""));
		}
	}
	if (budget <= 0) out.push("⋯ (snippet truncated)");
	return out.join("\n");
}

type AnchorOp =
	| { kind: "write"; content: string }
	| { kind: "replace"; anchorStr: string; endAnchorStr?: string; content: string }
	| { kind: "insert"; anchorStr: string; content: string; before: boolean };

function resolveOps(
	args: Record<string, unknown>,
	filePath: string,
): { ok: true; ops: AnchorOp[] } | { ok: false; error: string } {
	const rawOps = args.ops as unknown;

	if (!Array.isArray(rawOps) || rawOps.length === 0) {
		return {
			ok: false,
			error: `edit on ${filePath} needs ops[] — an array of {op, anchor?, end_anchor?, content} operations.`,
		};
	}

	const parsed: AnchorOp[] = [];
	for (const raw of rawOps) {
		if (!raw || typeof raw !== "object") {
			return {
				ok: false,
				error: `Invalid edit op in ${filePath}: expected an object, got ${JSON.stringify(raw)}`,
			};
		}
		const r = raw as Record<string, unknown>;
		if (r.op === "write") {
			if (typeof r.content !== "string") {
				return { ok: false, error: `Invalid write op in ${filePath}: content must be a string.` };
			}
			parsed.push({ kind: "write", content: r.content });
		} else if (r.op === "replace") {
			if (typeof r.anchor !== "string" || typeof r.content !== "string") {
				return { ok: false, error: `Invalid replace op in ${filePath}: anchor and content are required.` };
			}
			if (r.end_anchor !== undefined && typeof r.end_anchor !== "string") {
				return { ok: false, error: `Invalid replace op in ${filePath}: end_anchor must be a string.` };
			}
			parsed.push({
				kind: "replace",
				anchorStr: r.anchor,
				content: r.content,
				...(r.end_anchor ? { endAnchorStr: r.end_anchor } : {}),
			});
		} else if (r.op === "insert_after" || r.op === "insert_before") {
			if (typeof r.anchor !== "string" || typeof r.content !== "string") {
				return { ok: false, error: `Invalid ${r.op} op in ${filePath}: anchor and content are required.` };
			}
			parsed.push({ kind: "insert", anchorStr: r.anchor, content: r.content, before: r.op === "insert_before" });
		} else {
			return {
				ok: false,
				error: `Unknown edit op "${String(r.op)}" in ${filePath} — expected replace, insert_after, insert_before, or write.`,
			};
		}
	}
	return { ok: true, ops: parsed };
}

interface BucketedReplace {
	kind: "replace";
	lineStart: number;
	lineEnd: number;
	textLinesToInsert: string[];
	anchorStr: string;
}
interface BucketedInsert {
	kind: "insert";
	line: number;
	textLinesToInsert: string[];
	anchorStr: string;
}
type BucketedOp = BucketedReplace | BucketedInsert;
interface BucketFailure {
	ok: false;
	result: ToolResult;
}
interface BucketSuccess {
	ok: true;
	ops: BucketedOp[];
	/** Auto-recovery notes (shifted/drifted anchors) to surface in the reply. */
	notes: string[];
}

function bucketOps(
	ops: AnchorOp[],
	lines: string[],
	hashes: Array<[string, string]>,
	filePath: string,
): BucketSuccess | BucketFailure {
	const result: BucketedOp[] = [];
	const notes: string[] = [];
	for (let i = 0; i < ops.length; i++) {
		const op = ops[i]!;
		if (op.kind === "write") continue;
		if (op.kind === "replace") {
			const startResolved = resolveOpAnchor(op.anchorStr, hashes, lines, false);
			if (!startResolved.ok) return startResolved;
			if (startResolved.note) notes.push(startResolved.note);
			const endStr = (op as { endAnchorStr?: string }).endAnchorStr;
			let endAnchor = startResolved.anchor;
			if (endStr) {
				const end = resolveOpAnchor(endStr, hashes, lines, false);
				if (!end.ok) return end;
				if (end.note) notes.push(end.note);
				endAnchor = end.anchor;
			}
			// Validate (and possibly auto-recover) each anchor against the
			// current file; the resolved lines — not the anchors' own line
			// numbers — define the range.
			const startCheck = checkAnchor(startResolved.anchor, lines, hashes, startResolved.anchor.line);
			if (!startCheck.ok) return startCheck.failure;
			if (startCheck.note) notes.push(startCheck.note);
			const startLine = startCheck.line;
			let endLine = startLine;
			if (endStr) {
				const endCheck = checkAnchor(endAnchor, lines, hashes, endAnchor.line);
				if (!endCheck.ok) return endCheck.failure;
				if (endCheck.note) notes.push(endCheck.note);
				endLine = endCheck.line;
			}
			if (endLine < startLine) {
				return failBucket(
					`Range is inverted: end_anchor resolves to line ${endLine}, above anchor line ${startLine}. Re-read the file and pass the range top-down.`,
				);
			}
			result.push({
				kind: "replace",
				lineStart: startLine - 1,
				lineEnd: endLine - 1,
				textLinesToInsert: splitContent(op.content),
				anchorStr: op.anchorStr,
			});
		} else {
			// "0" / "0:" is the documented way to insert before the first
			// line — there is no line 0 to anchor on, so no hash is required.
			if (op.anchorStr === "0" || op.anchorStr === "0:") {
				result.push({
					kind: "insert",
					line: -1,
					textLinesToInsert: splitContent(op.content),
					anchorStr: op.anchorStr,
				});
				continue;
			}
			// "EOF" appends after the last real line (before a synthetic
			// trailing empty line from a final newline).
			if (op.anchorStr === "EOF" || op.anchorStr === "eof") {
				if (op.before) {
					return failBucket(
						`Anchor "EOF" is only valid with insert_after (append at end of file), not insert_before.`,
					);
				}
				const len = lines.length;
				const insertAt = len > 1 && (lines[len - 1] ?? "") === "" ? len - 1 : len;
				result.push({
					kind: "insert",
					line: insertAt - 1,
					textLinesToInsert: splitContent(op.content),
					anchorStr: op.anchorStr,
				});
				continue;
			}
			const resolved = resolveOpAnchor(op.anchorStr, hashes, lines, true);
			if (!resolved.ok) return resolved;
			if (resolved.note) notes.push(resolved.note);
			const check = checkAnchor(resolved.anchor, lines, hashes, resolved.anchor.line);
			if (!check.ok) return check.failure;
			if (check.note) notes.push(check.note);
			// Both insert flavours normalise to the same bucketed shape: the
			// 0-based line whose *end* is the splice point. insert_before N
			// is just insert_after N-1, with the anchor still validated
			// against line N itself.
			result.push({
				kind: "insert",
				line: check.line - (op.before ? 2 : 1),
				textLinesToInsert: splitContent(op.content),
				anchorStr: op.anchorStr,
			});
		}
	}

	// Range overlap on `replace` ops. Two ranges [a..b] and [c..d] collide
	// when they touch or cross. We reject the whole batch — the model gets
	// a fresh-anchor snippet and can retry with non-overlapping ops.
	const replaces = result.filter((o): o is BucketedReplace => o.kind === "replace");
	replaces.sort((a, b) => a.lineStart - b.lineStart);
	for (let i = 1; i < replaces.length; i++) {
		if (replaces[i]!.lineStart <= replaces[i - 1]!.lineEnd) {
			return failBucket(
				`Edit ops overlap in ${filePath} (anchor "${replaces[i - 1]!.anchorStr}" through "${replaces[i]!.anchorStr}"). Merge them into a single replace op instead.`,
			);
		}
	}

	// An insert whose splice point sits strictly inside a replace range
	// would splice into lines the replace is about to delete — the
	// inserted text silently vanishes. Splice points at the range's own
	// boundaries (before its first line / after its last) are unambiguous
	// and stay allowed.
	const inserts = result.filter((o): o is BucketedInsert => o.kind === "insert");
	for (const ins of inserts) {
		for (const rep of replaces) {
			if (ins.line >= rep.lineStart && ins.line < rep.lineEnd) {
				return failBucket(
					`Edit ops overlap in ${filePath}: insert anchor "${ins.anchorStr}" points inside the replace range "${rep.anchorStr}". Fold the inserted text into the replace content instead.`,
				);
			}
		}
	}
	return { ok: true, ops: result, notes };
}

interface AnchorCheckOk {
	ok: true;
	/** 1-based line the anchor resolved to (may differ from the anchor's own line after recovery). */
	line: number;
	/** Present when the anchor was auto-recovered — surfaced in the success reply. */
	note?: string;
}
interface AnchorCheckFail {
	ok: false;
	failure: BucketFailure;
}

type OpAnchorOk = {
	ok: true;
	anchor: NonNullable<ReturnType<typeof resolveAnchor>>["anchor"];
	note?: string;
};

/**
 * Parse a model anchor (full form, pasted gutter, or unique hash-only
 * suffix). Surfaces a pointed error with a fresh-anchor snippet when the
 * string is unusable so the model can retry without inventing a new
 * format.
 */
function resolveOpAnchor(
	anchorStr: string,
	hashes: Array<[string, string]>,
	lines: string[],
	allowTopInsertHint: boolean,
): OpAnchorOk | BucketFailure {
	const resolved = resolveAnchor(anchorStr, hashes);
	if (resolved) {
		const note = resolved.recoveredFromSuffix
			? `anchor "${anchorStr}": missing line number; matched uniquely as ${renderParsedAnchor(resolved.anchor)} and the edit was applied there.`
			: undefined;
		return { ok: true, anchor: resolved.anchor, ...(note ? { note } : {}) };
	}
	const head = stripAnchorGutter(anchorStr);
	// Hash-only form that matched zero or several lines — tell the model
	// explicitly instead of a generic "malformed".
	if (/^[a-z]+:[a-z]+$/.test(head) && !recoverAnchorBySuffix(anchorStr, hashes)) {
		const [local, chunk] = head.split(":");
		const hits: number[] = [];
		for (let i = 0; i < hashes.length; i++) {
			const [l, c] = hashes[i] ?? ["", ""];
			if (l === local && c === chunk) hits.push(i + 1);
		}
		const snippet = formatAnchorSnippet(lines, hashes, hits[0] ? hits[0] - 1 : 0, 4);
		if (hits.length === 0) {
			return failBucket(
				`Anchor "${anchorStr}" is missing the line number and matches no line in the file. ` +
					`Copy a full "<line>:<local>:<chunk>" from the snippet below:\n${snippet}`,
			);
		}
		return failBucket(
			`Anchor "${anchorStr}" is missing the line number and matches multiple lines (${hits.join(", ")}). ` +
				`Copy a full "<line>:<local>:<chunk>" from the snippet below:\n${snippet}`,
		);
	}
	const hint = allowTopInsertHint
		? ' Expected "<line>:<local>:<chunk>" as printed by read/grep (e.g. "22:abc:rst"), "0:" for top of file, or "EOF" to append.'
		: ' Expected "<line>:<local>:<chunk>" as printed by read/grep (e.g. "22:abc:rst").';
	const snippet = lines.length > 0 ? formatAnchorSnippet(lines, hashes, 0, 4) : "";
	const snippetBlock = snippet ? `\nFresh anchors from the start of the file:\n${snippet}` : "";
	return failBucket(`Anchor "${anchorStr}" is malformed.${hint}${snippetBlock}`);
}

/**
 * Resolve an anchor against the current file, recovering automatically
 * where the answer is unambiguous instead of bouncing an error back:
 *
 * - line content matches at the anchored line, only the chunk drifted
 *   (a neighbour was edited) → accept at the same line;
 * - line content matches exactly one line within the search window
 *   (content shifted, e.g. lines inserted above) → accept at that line.
 *
 * Both recoveries are reported via `note` so the model sees what
 * happened. Genuinely ambiguous or unmatchable anchors still fail — the
 * tool must never guess between candidates.
 */
function checkAnchor(
	anchor: NonNullable<ReturnType<typeof resolveAnchor>>["anchor"],
	lines: string[],
	hashes: Array<[string, string]>,
	targetLine: number,
): AnchorCheckOk | AnchorCheckFail {
	const anchorStr = renderParsedAnchor(anchor);

	const inRange = targetLine >= 1 && targetLine <= lines.length;
	if (inRange) {
		const verdict = validateAnchor({ ...anchor, line: targetLine }, hashes);
		if (verdict === "valid") return { ok: true, line: targetLine };
		// Chunk drift: the anchored line itself is byte-for-byte what the
		// model saw; only its neighbourhood changed. Editing it is exactly
		// the model's intent.
		const [currentLocal] = hashes[targetLine - 1] ?? ["", ""];
		if (currentLocal === anchor.localHash) {
			return {
				ok: true,
				line: targetLine,
				note: `anchor "${anchorStr}": nearby lines changed since your last read; the anchored line itself was unchanged and the edit was applied to it.`,
			};
		}
	}
	// Shift recovery: the content moved. A unique match within the search
	// window is accepted; anything else is the model's call to make.
	const shift = findShifted({ ...anchor, line: targetLine }, hashes);
	if (shift?.kind === "found") {
		return {
			ok: true,
			line: shift.newLine,
			note: `anchor "${anchorStr}": content had shifted from line ${targetLine} to line ${shift.newLine}; the edit was applied there.`,
		};
	}
	// Ambiguity between byte-identical *contiguous* duplicates is not real
	// ambiguity: replacing or inserting relative to any line of such a run
	// produces the same file. Without this, a duplicated line (e.g. a comment
	// pasted twice) dead-ends the edit — the model is told "lines 9, 10 both
	// match" with no way to express which, since duplicates share the anchor.
	if (shift?.kind === "ambiguous") {
		const cands = shift.candidates;
		const contiguous = cands.every((c, i) => i === 0 || c === cands[i - 1]! + 1);
		const first = lines[cands[0]! - 1];
		const identical = first !== undefined && cands.every((c) => lines[c - 1] === first);
		if (contiguous && identical) {
			const nearest = cands.reduce((a, b) => (Math.abs(b - targetLine) < Math.abs(a - targetLine) ? b : a));
			return {
				ok: true,
				line: nearest,
				note: `anchor "${anchorStr}": matched a run of identical lines (${cands.join(", ")}); they are interchangeable, so the edit was applied at line ${nearest}.`,
			};
		}
	}
	if (!inRange) {
		return { ok: false, failure: anchorNotFound(anchorStr, lines, hashes) };
	}
	return { ok: false, failure: staleAnchor(anchor, lines, hashes, targetLine, shift) };
}

function renderParsedAnchor(anchor: NonNullable<ReturnType<typeof resolveAnchor>>["anchor"]): string {
	return `${anchor.line}:${anchor.localHash}${anchor.chunkHash ? `:${anchor.chunkHash}` : ""}`;
}

function splitContent(content: string): string[] {
	// Empty content means "insert nothing": a replace with "" deletes the
	// range outright instead of leaving a blank line behind.
	if (content === "") return [];
	// Preserve the trailing-newline semantics of the old `newText` shape:
	// a content with a trailing newline produced an empty final line.
	return content.split("\n");
}

function failBucket(message: string): BucketFailure {
	return { ok: false, result: { content: message, isError: true } };
}

function anchorNotFound(badAnchor: string, lines: string[], hashes: Array<[string, string]>): BucketFailure {
	const snippet = formatAnchorSnippet(lines, hashes, lines.length - 1, 9);
	const msg =
		`Anchor "${badAnchor}" is past the end of the file (${lines.length} lines). ` +
		`Last lines of the file, with fresh anchors:\n${snippet}`;
	return failBucket(msg);
}

function staleAnchor(
	anchor: NonNullable<ReturnType<typeof resolveAnchor>>["anchor"],
	lines: string[],
	hashes: Array<[string, string]>,
	targetLine: number,
	shift: ReturnType<typeof findShifted>,
): BucketFailure {
	// Unique matches never reach this point — checkAnchor auto-recovers
	// them. What's left is genuinely ambiguous or gone.
	const badAnchor = renderParsedAnchor(anchor);
	const snippet = formatAnchorSnippet(lines, hashes, targetLine - 1, 5);
	if (shift?.kind === "ambiguous") {
		return failBucket(
			`Anchor "${badAnchor}" is stale at line ${targetLine}, and multiple nearby lines match it (lines ${shift.candidates.join(", ")}). ` +
				`Use the fresh anchors from the snippet below to retry:\n${snippet}`,
		);
	}
	return failBucket(
		`Anchor "${badAnchor}" is stale — the line no longer matches the hashes from your last read. ` +
			`Use the fresh anchors from the snippet below to retry:\n${snippet}`,
	);
}
