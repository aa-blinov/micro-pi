/**
 * File tools — `read` (with hashline anchors), `write`, and `edit` (anchor-
 * based ops with a backwards-compat shim for the old `{oldText, newText}`
 * shape). All paths resolve against the agent's cwd via resolvePath.
 */

import { constants } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import type { AppConfig } from "../config.ts";
import { computeLineHashes, formatAnchorSnippet, formatLineGutter, parseAnchor } from "./hashline.ts";
import { formatSize, resolvePath, type ToolResult } from "./shared.ts";

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

	await access(absolutePath, constants.R_OK);

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

	const content = await readFile(absolutePath, "utf-8");
	const allLines = content.split("\n");

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

	// Hashline gutter: each line is prefixed with `<LINE>:<HASH>→content` so
	// `edit` can reference lines without the model having to copy their text.
	// The arrow separator is never legal leading whitespace in source, so a
	// tab-indented file's real tabs stay unambiguous against the gutter —
	// same reason Claude Code's Read uses →. See `hashline.ts` for the
	// collision properties of the hash.
	const numbered = selectedLines
		.map((line, i) =>
			formatLineGutter({
				lineNumber: startLine + i + 1,
				content: line,
				prevContent: i === 0 ? (allLines[startLine - 1] ?? "") : (selectedLines[i - 1] ?? ""),
			}),
		)
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

	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content, "utf-8");

	return { content: `Successfully wrote ${content.length} bytes to ${filePath}` };
}

export async function execEdit(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
	const filePath = String(args.path ?? "");
	if (!filePath) return { content: "path is required", isError: true };

	const absolutePath = resolvePath(filePath, cwd);

	const resolved = resolveOps(args, filePath);
	if (!resolved.ok) return { content: resolved.error, isError: true };
	const ops = resolved.ops;

	// Read once; hashlines are computed against the snapshot the model last
	// saw, so applying ops bottom-up can't shift any anchor that hasn't been
	// validated yet. A `write` op short-circuits everything else.
	await access(absolutePath, constants.R_OK | constants.W_OK);
	const rawContent = await readFile(absolutePath, "utf-8");
	const lines = rawContent.split("\n");
	const hashes = computeLineHashes(rawContent);

	const writeOp = ops.find((o) => o.kind === "write");
	if (writeOp) {
		const content = (writeOp as { kind: "write"; content: string }).content;
		await writeFile(absolutePath, content, "utf-8");
		return { content: `Updated file ${filePath}.` };
	}

	// Bucket every non-write op into a typed record against the *pre-edit*
	// file. Validation here is what catches "stale anchor", "anchor not
	// found", "ambiguous anchor" and "range overlap" before anything is
	// written — the model gets the fresh-anchor snippet it needs to retry.
	const bucketResult = bucketOps(ops, lines, hashes);
	if (!bucketResult.ok) return bucketResult.result;

	// Apply bottom-up so each splice stays inside the original line
	// numbering. `replace` rewrites lines[a..b], `insert_after` splices
	// new lines after lines[a]. Either way earlier line numbers don't
	// shift, which is the whole reason anchored edits can be batched.
	const mutated = lines.slice();
	const sorted = bucketResult.ops.slice().sort((a, b) => {
		const la = a.kind === "insert" ? a.line : a.lineStart;
		const lb = b.kind === "insert" ? b.line : b.lineStart;
		return lb - la;
	});
	for (const op of sorted) {
		if (op.kind === "replace") {
			mutated.splice(op.lineStart, op.lineEnd - op.lineStart + 1, ...op.textLinesToInsert);
		} else {
			mutated.splice(op.line + 1, 0, ...op.textLinesToInsert);
		}
	}

	await writeFile(absolutePath, mutated.join("\n"), "utf-8");
	return { content: `Updated ${ops.length} block(s) in ${filePath}.` };
}

type AnchorOp =
	| { kind: "write"; content: string }
	| { kind: "replace"; anchorStr: string; endAnchorStr?: string; content: string }
	| { kind: "insert"; anchorStr: string; content: string };

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
		} else if (r.op === "insert_after") {
			if (typeof r.anchor !== "string" || typeof r.content !== "string") {
				return { ok: false, error: `Invalid insert_after op in ${filePath}: anchor and content are required.` };
			}
			parsed.push({ kind: "insert", anchorStr: r.anchor, content: r.content });
		} else {
			return {
				ok: false,
				error: `Unknown edit op "${String(r.op)}" in ${filePath} — expected replace, insert_after, or write.`,
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
}

function bucketOps(ops: AnchorOp[], lines: string[], hashes: Array<[string, string]>): BucketSuccess | BucketFailure {
	const result: BucketedOp[] = [];
	for (let i = 0; i < ops.length; i++) {
		const op = ops[i]!;
		if (op.kind === "write") continue;
		if (op.kind === "replace") {
			const anchor = parseAnchor(op.anchorStr);
			if (!anchor)
				return failBucket(
					`Anchor "${op.anchorStr}" is malformed. Expected "<line>:<hash>" or "<line>:<hash>:<secondary>".`,
				);
			const endStr = (op as { endAnchorStr?: string }).endAnchorStr;
			const endAnchor = endStr ? parseAnchor(endStr) : undefined;
			if (endStr && !endAnchor) return failBucket(`end_anchor "${endStr}" is malformed. Expected "<line>:<hash>".`);
			const startLine = anchor.line;
			const endLine = endAnchor ? endAnchor.line : startLine;
			if (startLine < 1 || startLine > lines.length) {
				return anchorNotFound(op.anchorStr, lines, hashes);
			}
			if (endLine < startLine || endLine > lines.length) {
				return anchorNotFound(endAnchor?.line ? `${endLine}:${endAnchor.primaryHash}` : "EOF", lines, hashes);
			}
			// Validate each touched line against the stored hash; the model
			// might have edited a single line or a range — every anchor
			// matters.
			const startCheck = checkAnchor(anchor, lines, hashes, startLine);
			if (!startCheck.ok) return startCheck.failure;
			if (endAnchor) {
				const endCheck = checkAnchor(endAnchor, lines, hashes, endLine);
				if (!endCheck.ok) return endCheck.failure;
				if (startLine === endLine && anchor.secondaryHash && endAnchor.secondaryHash === undefined) {
					// model omitted the secondary on the second anchor — harmless.
				}
			}
			result.push({
				kind: "replace",
				lineStart: startLine - 1,
				lineEnd: endLine - 1,
				textLinesToInsert: splitContent(op.content),
				anchorStr: op.anchorStr,
			});
		} else {
			const anchor = parseAnchor(op.anchorStr);
			if (!anchor)
				return failBucket(
					`Anchor "${op.anchorStr}" is malformed. Expected "<line>:<hash>" or "<line>:<hash>:<secondary>".`,
				);
			const check = checkAnchor(anchor, lines, hashes, anchor.line);
			if (!check.ok) return check.failure;
			result.push({
				kind: "insert",
				line: anchor.line - 1,
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
				`Edit ops overlap in ${""} (anchor "${replaces[i - 1]!.anchorStr}" through "${replaces[i]!.anchorStr}"). Merge them into a single replace op instead.`,
			);
		}
	}
	return { ok: true, ops: result };
}

interface AnchorCheckOk {
	ok: true;
}
interface AnchorCheckFail {
	ok: false;
	failure: BucketFailure;
}

function checkAnchor(
	anchor: ReturnType<typeof parseAnchor>,
	lines: string[],
	hashes: Array<[string, string]>,
	targetLine: number,
): AnchorCheckOk | AnchorCheckFail {
	if (!anchor) return { ok: false, failure: failBucket("Malformed anchor.") };
	if (targetLine < 1 || targetLine > lines.length) {
		return { ok: false, failure: anchorNotFound(`${anchor.line}:${anchor.primaryHash}`, lines, hashes) };
	}
	const [expectedPrimary, expectedSecondary] = hashes[targetLine - 1] ?? ["", ""];

	// First, exact match: both primary and (optional) secondary match at
	// `targetLine`. The model's anchor is intentionally stable when the
	// line hasn't moved — no need to inspect the rest of the file.
	if (expectedPrimary === anchor.primaryHash) {
		if (!anchor.secondaryHash || expectedSecondary === anchor.secondaryHash) {
			return { ok: true };
		}
		// The line's primary hash matches, but the secondary doesn't — the
		// file has drifted (e.g. the previous line was edited). Fall through
		// to stale handling.
	}

	// Look across the rest of the file to figure out whether the model's
	// anchor is stale (no matching line) or merely ambiguous (the model
	// skipped the secondary and more than one line shares the primary).
	const primaryMatches: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const [p] = hashes[i] ?? ["", ""];
		if (p === anchor.primaryHash) primaryMatches.push(i + 1);
	}
	if (primaryMatches.length > 1 && !anchor.secondaryHash) {
		return {
			ok: false,
			failure: failBucket(
				`Anchor "${anchor.line}:${anchor.primaryHash}" is ambiguous — the same primary hash matches lines ${primaryMatches.join(", ")}. Re-read the file and pass the full "<line>:<primary>:<secondary>" form for each line you want to edit.`,
			),
		};
	}
	// No line in the file matches the anchor at all — stale.
	return {
		ok: false,
		failure: staleAnchor(
			`${anchor.line}:${anchor.primaryHash}${anchor.secondaryHash ? `:${anchor.secondaryHash}` : ""}`,
			expectedPrimary,
			expectedSecondary,
			lines,
			hashes,
			targetLine,
		),
	};
}

function splitContent(content: string): string[] {
	if (content === "") return [""];
	// Preserve the trailing-newline semantics of the old `newText` shape:
	// a content with a trailing newline produced an empty final line.
	return content.split("\n");
}

function failBucket(message: string): BucketFailure {
	return { ok: false, result: { content: message, isError: true } };
}

function anchorNotFound(badAnchor: string, lines: string[], _hashes: Array<[string, string]>): BucketFailure {
	const centre = lines.length;
	const snippet = formatAnchorSnippet(lines, Math.max(1, centre - 5), 5);
	const freshList = freshAnchorList(lines, 10);
	const msg =
		`Anchor "${badAnchor}" is past the end of the file (${lines.length} lines). ` +
		`Use one of these anchors instead:\n${freshList}\n\n` +
		`Last lines of the file:\n${snippet}`;
	return failBucket(msg);
}

function staleAnchor(
	badAnchor: string,
	expectedPrimary: string,
	expectedSecondary: string,
	lines: string[],
	_hashes: Array<[string, string]>,
	targetLine: number,
): BucketFailure {
	const snippet = formatAnchorSnippet(lines, targetLine, 2);
	const freshList = freshAnchorList(lines, 10);
	const expected =
		expectedSecondary && expectedSecondary !== expectedPrimary.slice(0, expectedSecondary.length)
			? `${expectedPrimary}:${expectedSecondary}`
			: expectedPrimary;
	const msg =
		`Anchor "${badAnchor}" is stale — the line no longer matches the hash from your last read. ` +
		`Expected anchor at that line is "${expected}". ` +
		`Re-read or use one of these fresh anchors:\n${freshList}\n\n` +
		`Snippet around the requested line:\n${snippet}`;
	return failBucket(msg);
}

function freshAnchorList(lines: string[], count: number): string {
	const out: string[] = [];
	for (let i = 0; i < Math.min(lines.length, count); i++) {
		out.push(formatLineGutter({ lineNumber: i + 1, content: lines[i] ?? "", prevContent: lines[i - 1] }));
	}
	return out.join("\n");
}
