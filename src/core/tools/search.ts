/**
 * Search tools — `find` (filename glob, via fd), `grep` (content, via rg), and
 * `ls`. fd/rg are used when installed; otherwise a built-in tree walk provides
 * a degraded fallback that still skips default-ignored dirs and honours
 * .gitignore (including nested ones), which a bare `find`/`grep -r` wouldn't.
 */

import { execFileSync } from "node:child_process";
import { constants, type Dirent } from "node:fs";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { AppConfig } from "../config.ts";
import { hash, secondarySuffix } from "./hashline.ts";
import { formatSize, resolvePath, type ToolResult } from "./shared.ts";

// ============================================================================
// Fallback file walking — used when fd/rg aren't installed. fd/rg both skip
// node_modules/.git/etc and respect .gitignore by default; a bare `find`/
// `grep -r` doesn't, and without this a fallback search over a real repo
// returns thousands of node_modules matches instead of failing cleanly.
// This isn't a full .gitignore implementation (no negation, no nested
// .gitignore files) — just enough to keep a degraded-but-missing-fd/rg
// search usable.
// ============================================================================

const DEFAULT_IGNORE_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	".nuxt",
	"out",
	"target",
	".venv",
	"venv",
	"__pycache__",
	".cache",
	".turbo",
]);

const MAX_WALK_FILES = 20_000;
const MAX_GREP_FILE_BYTES = 5 * 1024 * 1024;

interface GitignoreRule {
	regex: RegExp;
	dirOnly: boolean;
	negated: boolean;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert a glob pattern to a regex source, character by character -- avoids
 * chained .replace() calls with placeholder tokens, which are easy to get
 * subtly wrong. `**` matches across path separators; a lone `*` doesn't.
 */
function globToRegExpSource(glob: string): string {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i]!;
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				out += ".*";
				i++;
			} else {
				out += "[^/]*";
			}
		} else if (ch === "?") {
			out += "[^/]";
		} else if (ch === "{") {
			// Brace expansion: {a,b,c} → (a|b|c)
			const close = glob.indexOf("}", i);
			if (close !== -1) {
				const alternatives = glob
					.slice(i + 1, close)
					.split(",")
					.map((alt) => globToRegExpSource(alt));
				out += `(${alternatives.join("|")})`;
				i = close;
			} else {
				out += escapeRegExp(ch);
			}
		} else {
			out += escapeRegExp(ch);
		}
	}
	return out;
}

function parseGitignoreFile(text: string): GitignoreRule[] {
	const rules: GitignoreRule[] = [];
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		const negated = line.startsWith("!");
		const body = negated ? line.slice(1) : line;
		const dirOnly = body.endsWith("/");
		const pattern = dirOnly ? body.slice(0, -1) : body;
		const anchored = pattern.startsWith("/");
		const globBody = globToRegExpSource(anchored ? pattern.slice(1) : pattern);

		rules.push({ regex: new RegExp(anchored ? `^${globBody}$` : `(^|/)${globBody}$`), dirOnly, negated });
	}
	return rules;
}

async function parseGitignore(root: string): Promise<GitignoreRule[]> {
	let text: string;
	try {
		text = await readFile(join(root, ".gitignore"), "utf-8");
	} catch {
		return [];
	}
	return parseGitignoreFile(text);
}

async function parseGitignoreNested(dir: string): Promise<GitignoreRule[]> {
	let text: string;
	try {
		text = await readFile(join(dir, ".gitignore"), "utf-8");
	} catch {
		return [];
	}
	return parseGitignoreFile(text);
}

function isGitignored(relPath: string, isDir: boolean, rules: GitignoreRule[]): boolean {
	let ignored = false;
	for (const rule of rules) {
		if (!rule.dirOnly || isDir) {
			if (rule.regex.test(relPath)) {
				ignored = !rule.negated;
			}
		}
	}
	return ignored;
}

function globToFileRegExp(glob: string): RegExp {
	return new RegExp(`^${globToRegExpSource(glob)}$`);
}

/** Collect file paths under searchPath, skipping default-ignored dirs and .gitignore matches. */
async function walkFiles(cwd: string, searchPath: string, maxFiles: number = MAX_WALK_FILES): Promise<string[]> {
	const rootRules = await parseGitignore(cwd);
	const visited = new Set<string>();
	const stack: Array<{ dir: string; rules: GitignoreRule[] }> = [{ dir: searchPath, rules: rootRules }];
	const results: string[] = [];

	while (stack.length > 0 && results.length < maxFiles) {
		const { dir, rules } = stack.pop()!;
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (results.length >= maxFiles) break;
			const absPath = join(dir, entry.name);
			const relPath = relative(cwd, absPath);
			const isDir = entry.isDirectory();

			if (isDir && DEFAULT_IGNORE_DIRS.has(entry.name)) continue;

			// Resolve symlinks to detect cycles — a symlink pointing to an
			// ancestor directory would loop forever without this.
			if (entry.isSymbolicLink()) {
				try {
					const real = await realpath(absPath);
					if (visited.has(real)) continue;
					visited.add(real);
					const st = await stat(real);
					if (st.isDirectory()) {
						const nestedRules = await parseGitignoreNested(real);
						stack.push({ dir: real, rules: [...rules, ...nestedRules] });
					} else if (st.isFile()) {
						if (!isGitignored(relPath, false, rules)) results.push(real);
					}
				} catch {
					continue;
				}
				continue;
			}

			if (isGitignored(relPath, isDir, rules)) continue;

			if (isDir) {
				const nestedRules = await parseGitignoreNested(absPath);
				stack.push({ dir: absPath, rules: [...rules, ...nestedRules] });
			} else if (entry.isFile()) {
				results.push(absPath);
			}
		}
	}
	return results;
}

export async function execFind(args: Record<string, unknown>, cwd: string, _config: AppConfig): Promise<ToolResult> {
	const pattern = String(args.pattern ?? "");
	const searchPath = args.path ? resolvePath(String(args.path), cwd) : cwd;
	const limit = typeof args.limit === "number" ? args.limit : 1000;

	const gitignorePath = join(searchPath, ".gitignore");
	const hasGitignore = await access(gitignorePath, constants.R_OK)
		.then(() => true)
		.catch(() => false);

	let absolutePaths: string[];
	try {
		// execFileSync runs the binary directly, no shell involved — unlike the
		// execSync(`fd ... '${pattern}' ...`) this replaced, a pattern
		// containing a single quote can't break out of the argument and inject
		// arbitrary shell commands (confirmed exploitable: a pattern like
		// `x'; echo pwned > /tmp/x; echo '` ran the injected command). Callers
		// don't get a say here — pattern/path come straight from a tool call
		// argument, so this can't rely on the input being well-behaved.
		//
		// --ignore-file: fd doesn't respect .gitignore outside git repos;
		// pass it explicitly so negation rules work everywhere. Nested
		// .gitignore files in subdirectories are not auto-discovered by fd
		// (ponytail: would need a pre-walk to collect them); the walkFiles
		// fallback handles them when fd is absent.
		const fdArgs = ["--glob", "--type", "f", "--max-results", String(limit)];
		if (hasGitignore) fdArgs.push("--ignore-file", gitignorePath);
		fdArgs.push(pattern, searchPath);
		// Capture stderr rather than inheriting it — an invalid glob makes fd
		// print "[fd error]: …" which would otherwise land in the TUI frame.
		const output = execFileSync("fd", fdArgs, {
			encoding: "utf-8",
			timeout: 10_000,
			cwd: searchPath,
			stdio: ["ignore", "pipe", "pipe"],
		});
		absolutePaths = output.trim().split("\n").filter(Boolean);
	} catch {
		// fd isn't installed or returned an error (e.g. invalid glob
		// pattern) — walk the tree ourselves, matching the pattern
		// against basenames like `find -name` does.
		const nameRe = globToFileRegExp(pattern);
		const allFiles = await walkFiles(cwd, searchPath);
		absolutePaths = allFiles.filter((p) => nameRe.test(basename(p))).slice(0, limit);
	}

	if (absolutePaths.length === 0) return { content: "No files found" };

	const relativePaths = absolutePaths.map((p) => (p.startsWith(cwd) ? p.slice(cwd.length + 1) : p));
	return { content: relativePaths.join("\n") };
}

/** True for filesystem errors that mean "not allowed to read this", as opposed
 * to "doesn't exist". On macOS these are what a denied Full Disk Access / folder
 * (TCC) permission produces when a tool walks into ~/Documents, ~/Desktop, etc. */
export function isPermissionError(err: unknown): boolean {
	const code = (err as { code?: string })?.code;
	return code === "EPERM" || code === "EACCES";
}

/** Append a one-line note when the search couldn't read everything because of
 * permissions — either the JS fallback hit EPERM/EACCES on some paths, or rg's
 * stderr reported it. Without this the tool silently under-matches: the model
 * (and the user) never learn that files were skipped, not simply absent. */
export function withAccessNote(output: string, rgStderr: string, permissionSkips: number): string {
	const rgDenied = /operation not permitted|permission denied/i.test(rgStderr);
	if (permissionSkips === 0 && !rgDenied) return output;
	const skipped = permissionSkips > 0 ? `${permissionSkips} path(s)` : "some paths";
	const note = `[note: ${skipped} skipped — permission denied. On macOS, grant your terminal app Full Disk Access in System Settings → Privacy & Security, then restart it.]`;
	return output ? `${output}\n${note}` : note;
}

export async function execGrep(args: Record<string, unknown>, cwd: string, config: AppConfig): Promise<ToolResult> {
	const pattern = String(args.pattern ?? "");
	const searchPath = args.path ? resolvePath(String(args.path), cwd) : cwd;
	const glob = args.glob ? String(args.glob) : undefined;
	const ignoreCase = args.ignoreCase === true;
	const literal = args.literal === true;
	const context = typeof args.context === "number" ? args.context : 0;
	const limit = typeof args.limit === "number" ? args.limit : 100;

	// Build rg command
	const flags: string[] = ["--line-number", "--no-heading"];
	if (ignoreCase) flags.push("--ignore-case");
	if (literal) flags.push("--fixed-strings");
	if (context > 0) flags.push(`--context=${context}`);
	if (glob) flags.push(`--glob=${glob}`);
	flags.push("--max-count", String(limit));

	let output: string;
	try {
		// See execFind for why this is execFileSync with an argument array and
		// not execSync + string interpolation: pattern/glob come straight from
		// a tool call argument, and a shell-interpolated `'${pattern}'` is
		// exploitable by anything containing a single quote (confirmed with a
		// payload that ran an injected command).
		// stdio: capture stderr instead of letting it inherit the parent's —
		// otherwise rg's per-file warnings ("path: Permission denied") print
		// straight into the Ink TUI, corrupting the frame, and never reach the
		// error object below where we want to inspect them.
		output = execFileSync("rg", [...flags, "--", pattern, searchPath], {
			encoding: "utf-8",
			timeout: 10_000,
			maxBuffer: config.maxToolOutputBytes,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		// rg's exit codes: 0 = matches found, 1 = ran cleanly but nothing
		// matched, 2 = a real error (bad regex, unreadable root, …). Node's
		// execFileSync throws on any non-zero exit, so we have to disambiguate.
		const e = err as { status?: number | null; code?: string; stderr?: string | Buffer };
		const rgStderr = typeof e.stderr === "string" ? e.stderr : e.stderr ? e.stderr.toString() : "";

		// Exit 1 = "no matches". rg already did the work and found nothing —
		// return immediately. The old code fell through to the whole-tree JS
		// walk here on *every* empty search: pointless work, and on a large
		// tree under ~/Documents it re-walks macOS-protected folders, firing a
		// TCC permission prompt for a query that was simply going to be empty.
		if (e.status === 1) {
			return { content: withAccessNote("No matches found", rgStderr, 0) };
		}

		// Anything else — rg not installed (ENOENT), wrong-arch binary, timeout,
		// buffer overflow, or a genuine rg error (status 2) — falls back to the
		// JS walk. Track paths skipped for permission reasons so a macOS TCC /
		// Full Disk Access problem surfaces instead of silently under-matching.
		let permissionSkips = 0;

		let patternRe: RegExp;
		try {
			patternRe = new RegExp(literal ? escapeRegExp(pattern) : pattern, ignoreCase ? "i" : "");
		} catch {
			return { content: `Invalid pattern: ${pattern}`, isError: true };
		}

		const globRe = glob ? globToFileRegExp(glob) : undefined;
		const allFiles = await walkFiles(cwd, searchPath);
		const candidates = globRe ? allFiles.filter((p) => globRe.test(basename(p))) : allFiles;

		const blocks: string[] = [];
		outer: for (const absPath of candidates) {
			let stats: Awaited<ReturnType<typeof stat>>;
			try {
				stats = await stat(absPath);
			} catch (statErr) {
				if (isPermissionError(statErr)) permissionSkips++;
				continue;
			}
			if (stats.size > MAX_GREP_FILE_BYTES) continue;

			let fileText: string;
			try {
				fileText = await readFile(absPath, "utf-8");
			} catch (readErr) {
				if (isPermissionError(readErr)) permissionSkips++;
				continue;
			}

			const fileLines = fileText.split("\n");
			const relPath = absPath.startsWith(cwd) ? absPath.slice(cwd.length + 1) : absPath;

			for (let i = 0; i < fileLines.length; i++) {
				if (!patternRe.test(fileLines[i]!)) continue;
				const start = Math.max(0, i - context);
				const end = Math.min(fileLines.length, i + context + 1);
				blocks.push(
					fileLines
						.slice(start, end)
						.map((line, j) => `${relPath}:${start + j + 1}:${line}`)
						.join("\n"),
				);
				if (blocks.length >= limit) break outer;
			}
		}

		output = withAccessNote(blocks.join("\n"), rgStderr, permissionSkips);
	}

	const lines = output.trim().split("\n");
	if (lines.length > 0 && lines[0] !== "") {
		output = await annotateWithHashes(output, cwd, searchPath);
	}
	if (lines.length > config.maxToolOutputLines) {
		const kept = lines.slice(0, config.maxToolOutputLines);
		return {
			content: `[Showing first ${config.maxToolOutputLines} of ${lines.length} lines]\n${kept.join("\n")}`,
		};
	}

	return { content: output.trim() || "No matches found" };
}

/**
 * Rewrite each `relPath:line:content` line in `output` to
 * `relPath:line:HASH[:HH]:content` so the model can copy the anchor into
 * an `edit` call without a separate `read`. Reads each unique file once
 * and caches the splits — without the cache a busy grep on a project
 * tree would do N reads for N matches and pay the I/O on every line.
 */
async function annotateWithHashes(output: string, cwd: string, searchPath: string): Promise<string> {
	const fileCache = new Map<string, string[]>();
	const annotated: string[] = [];
	for (const rawLine of output.split("\n")) {
		const parsed = parseGrepLine(rawLine);
		if (!parsed) {
			annotated.push(rawLine);
			continue;
		}
		const absPath = resolveGrepPath(parsed.relPath, cwd, searchPath);
		let fileLines = fileCache.get(absPath);
		if (!fileLines) {
			try {
				const text = await readFile(absPath, "utf-8");
				fileLines = text.split("\n");
			} catch {
				// File became unreadable between rg and us, or rg gave us
				// a path we can't resolve. Drop the line through unchanged
				// rather than fabricating a hash we can't defend.
				annotated.push(rawLine);
				continue;
			}
			fileCache.set(absPath, fileLines);
		}
		const content = fileLines[parsed.line - 1] ?? parsed.content;
		const prev = fileLines[parsed.line - 2] ?? "";
		const [primary] = hash(parsed.line, content, prev);
		const suffix = secondarySuffix(parsed.line, content, prev);
		annotated.push(
			suffix
				? `${parsed.relPath}:${parsed.line}:${primary}:${suffix}:${content}`
				: `${parsed.relPath}:${parsed.line}:${primary}:${content}`,
		);
	}
	return annotated.join("\n");
}

interface ParsedGrepLine {
	relPath: string;
	line: number;
	content: string;
}

function parseGrepLine(line: string): ParsedGrepLine | null {
	// rg's output is `<relPath>:<line>:<content>`. The path is the
	// leftmost field terminated by a non-`:` colon; the line is the
	// next; the rest is content (which itself can contain `:`).
	const firstColon = line.indexOf(":");
	if (firstColon < 1) return null;
	const secondColon = line.indexOf(":", firstColon + 1);
	if (secondColon < 1) return null;
	const relPath = line.slice(0, firstColon);
	const lineNo = Number.parseInt(line.slice(firstColon + 1, secondColon), 10);
	if (!Number.isFinite(lineNo) || lineNo < 1) return null;
	return { relPath, line: lineNo, content: line.slice(secondColon + 1) };
}

function resolveGrepPath(relPath: string, cwd: string, searchPath: string): string {
	// rg prints paths relative to the search root it was given. We
	// reinstate an absolute path so `readFile` is unambiguous; the relPath
	// we keep in the model-facing output is unchanged either way.
	if (relPath.startsWith("/")) return relPath;
	const base = searchPath && searchPath !== cwd ? searchPath : cwd;
	return join(base, relPath);
}

export async function execLs(args: Record<string, unknown>, cwd: string, _config: AppConfig): Promise<ToolResult> {
	const dirPath = args.path ? resolvePath(String(args.path), cwd) : cwd;
	const limit = typeof args.limit === "number" ? args.limit : 500;

	const entries = await readdir(dirPath, { withFileTypes: true });
	const lines: string[] = [];

	for (const entry of entries.slice(0, limit)) {
		const isDir = entry.isDirectory();
		const prefix = isDir ? "d" : "f";
		let size = "";
		if (!isDir) {
			try {
				const s = await stat(join(dirPath, entry.name));
				size = formatSize(s.size);
			} catch {
				size = "?";
			}
		}
		lines.push(`${prefix}  ${size.padStart(8)}  ${entry.name}${isDir ? "/" : ""}`);
	}

	if (entries.length > limit) {
		lines.push(`\n... (${entries.length - limit} more entries, ${entries.length} total)`);
	}

	return { content: lines.join("\n") || "(empty directory)" };
}
