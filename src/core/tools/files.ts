/**
 * File tools — `read` (text or image), `write`, and `edit` (unique-match,
 * non-overlapping multi-block replacement). All paths resolve against the
 * agent's cwd via resolvePath.
 */

import { constants } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import type { AppConfig } from "../config.ts";
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

	// Add line numbers. Separator is "→" (U+2192), not a tab — a tab-indented
	// file would otherwise put a gutter tab directly ahead of the file's own
	// leading tabs with nothing to tell them apart (e.g. "1784" + "\t" +
	// "\t\t\t\tconst x" — is that 4 or 5 real tabs of indentation?). Confirmed
	// this is exactly why edit's oldText kept failing to match on a real
	// tab-indented file: the model can't reliably subtract out an invisible
	// separator tab it has no way to distinguish from real indentation, so it
	// reconstructs a plausible-looking but wrong tab count. An arrow can never
	// legitimately appear as leading whitespace in source, so it's an
	// unambiguous boundary — same convention Claude Code's own Read tool uses.
	const numbered = selectedLines.map((line, i) => `${startLine + i + 1}→${line}`).join("\n");

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
	const edits = args.edits as Array<{ oldText: string; newText: string }> | undefined;

	if (!Array.isArray(edits) || edits.length === 0) {
		return { content: "edits must contain at least one replacement", isError: true };
	}

	const absolutePath = resolvePath(filePath, cwd);
	await access(absolutePath, constants.R_OK | constants.W_OK);
	const rawContent = await readFile(absolutePath, "utf-8");

	// Locate every edit's unique range in the ORIGINAL content up front —
	// not sequentially against a string mutated by earlier edits in this
	// same call. Sequential matching meant edit #2 could spuriously fail to
	// find text edit #1 already replaced, or spuriously collide with text
	// edit #1's replacement happened to introduce, even though both were
	// unique in the file the model actually read. This now matches the
	// tool's own documented contract: "must match a unique, non-overlapping
	// region of the original file."
	const ranges: Array<{ start: number; end: number; newText: string }> = [];
	for (const edit of edits) {
		const idx = rawContent.indexOf(edit.oldText);
		if (idx === -1) {
			return {
				content: `Could not find oldText in ${filePath}: "${edit.oldText.slice(0, 100)}${edit.oldText.length > 100 ? "..." : ""}"`,
				isError: true,
			};
		}
		const secondIdx = rawContent.indexOf(edit.oldText, idx + 1);
		if (secondIdx !== -1) {
			return {
				content: `oldText is not unique in ${filePath}: found at least 2 occurrences`,
				isError: true,
			};
		}
		ranges.push({ start: idx, end: idx + edit.oldText.length, newText: edit.newText });
	}

	// Overlap can only happen between edits that matched different oldText
	// (a shared prefix/suffix, or literally the same text twice) — wasn't
	// checked at all before, so two colliding edits would silently produce
	// whichever result the sequential application order happened to yield.
	ranges.sort((a, b) => a.start - b.start);
	for (let i = 1; i < ranges.length; i++) {
		if (ranges[i]!.start < ranges[i - 1]!.end) {
			return {
				content: `Edits overlap in ${filePath}: two edits' oldText matched overlapping regions of the original file. Merge them into a single edit instead.`,
				isError: true,
			};
		}
	}

	let result = "";
	let cursor = 0;
	for (const range of ranges) {
		result += rawContent.slice(cursor, range.start) + range.newText;
		cursor = range.end;
	}
	result += rawContent.slice(cursor);

	await writeFile(absolutePath, result, "utf-8");
	return { content: `Successfully replaced ${edits.length} block(s) in ${filePath}.` };
}
