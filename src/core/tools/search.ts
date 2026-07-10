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
		const output = execFileSync("fd", fdArgs, {
			encoding: "utf-8",
			timeout: 10_000,
			cwd: searchPath,
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
		output = execFileSync("rg", [...flags, "--", pattern, searchPath], {
			encoding: "utf-8",
			timeout: 10_000,
			maxBuffer: config.maxToolOutputBytes,
		});
	} catch {
		// rg isn't installed or returned an error — walk the tree and
		// match content ourselves, skipping node_modules/.git/etc and
		// .gitignore matches.
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
			} catch {
				continue;
			}
			if (stats.size > MAX_GREP_FILE_BYTES) continue;

			let fileText: string;
			try {
				fileText = await readFile(absPath, "utf-8");
			} catch {
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

		output = blocks.join("\n");
	}

	const lines = output.trim().split("\n");
	if (lines.length > config.maxToolOutputLines) {
		const kept = lines.slice(0, config.maxToolOutputLines);
		return {
			content: `[Showing first ${config.maxToolOutputLines} of ${lines.length} lines]\n${kept.join("\n")}`,
		};
	}

	return { content: output.trim() || "No matches found" };
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
