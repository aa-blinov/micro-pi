import { execFileSync, spawn } from "node:child_process";
import { constants, type Dirent } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { AppConfig } from "./config.ts";
import type { Tool } from "./llm.ts";
import { checkDangerousBash } from "./permissions.ts";
import { getStdinSource, suspendAndRun } from "./stdin-manager.ts";

// ============================================================================
// Tool definitions (OpenAI function calling format)
// ============================================================================

export function getToolDefinitions(): Tool[] {
	return [
		{
			type: "function",
			function: {
				name: "bash",
				description:
					"Execute a bash command in the current working directory. Returns stdout and stderr. " +
					"Output is truncated to last 2000 lines or 64KB (whichever is hit first). " +
					"Optionally provide a timeout in seconds.",
				parameters: {
					type: "object",
					properties: {
						command: { type: "string", description: "Bash command to execute" },
						timeout: { type: "number", description: "Timeout in seconds (optional)" },
					},
					required: ["command"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "read",
				description:
					"Read the contents of a file. Supports text files and images (jpg, jpeg, png, gif, webp, bmp — " +
					"shown to you as an image in the next message; only works if the model supports vision). " +
					"Output is truncated to 2000 lines or 64KB. Use offset/limit for large files. " +
					"Images larger than 5MB are rejected.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Path to the file to read (relative or absolute)" },
						offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
						limit: { type: "number", description: "Maximum number of lines to read" },
					},
					required: ["path"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "write",
				description:
					"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. " +
					"Automatically creates parent directories.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Path to the file to write (relative or absolute)" },
						content: { type: "string", description: "Content to write to the file" },
					},
					required: ["path", "content"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "edit",
				description:
					"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, " +
					"non-overlapping region of the original file. If two changes touch the same block or nearby lines, " +
					"merge them into one edit instead of emitting overlapping edits.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
						edits: {
							type: "array",
							items: {
								type: "object",
								properties: {
									oldText: {
										type: "string",
										description: "Exact text for one targeted replacement. Must be unique in the file.",
									},
									newText: { type: "string", description: "Replacement text for this targeted edit." },
								},
								required: ["oldText", "newText"],
							},
							description: "One or more targeted replacements. Each is matched against the original file.",
						},
					},
					required: ["path", "edits"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "find",
				description: "Search for files by glob pattern (e.g. '*.ts', '**/*.json', 'src/**/*.spec.ts').",
				parameters: {
					type: "object",
					properties: {
						pattern: { type: "string", description: "Glob pattern to match files" },
						path: { type: "string", description: "Directory to search in (default: current directory)" },
						limit: { type: "number", description: "Maximum number of results (default: 1000)" },
					},
					required: ["pattern"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "grep",
				description:
					"Search file contents by regex pattern. Supports context lines, case-insensitive, literal mode.",
				parameters: {
					type: "object",
					properties: {
						pattern: { type: "string", description: "Search pattern (regex or literal string)" },
						path: { type: "string", description: "Directory or file to search (default: current directory)" },
						glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts'" },
						ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" },
						literal: { type: "boolean", description: "Treat pattern as literal string (default: false)" },
						context: { type: "number", description: "Lines before/after each match (default: 0)" },
						limit: { type: "number", description: "Maximum number of matches (default: 100)" },
					},
					required: ["pattern"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "ls",
				description: "List directory contents. Shows file type, size, and name.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Directory to list (default: current directory)" },
						limit: { type: "number", description: "Maximum number of entries (default: 500)" },
					},
				},
			},
		},
	];
}

// ============================================================================
// Path resolution
// ============================================================================

function resolvePath(path: string, cwd: string): string {
	if (isAbsolute(path)) return path;
	return resolve(cwd, path);
}

// ============================================================================
// Tool execution
// ============================================================================

export interface ToolResult {
	content: string;
	isError?: boolean;
	/**
	 * Set by `read` when the file is an image. A `role: "tool"` message can't
	 * carry image content per the OpenAI-compatible chat API, so the loop
	 * follows it up with a separate `role: "user"` image message instead.
	 */
	imageDataUrl?: string;
}

export type ToolExecutor = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;

/** Asked before running a bash command that matches a known-dangerous pattern. Return false to block it. */
export type ConfirmBash = (command: string, reason: string) => Promise<boolean>;

export function createToolExecutor(cwd: string, config: AppConfig, confirmBash?: ConfirmBash): ToolExecutor {
	return async (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> => {
		try {
			switch (name) {
				case "bash":
					return await execBash(args, cwd, config, confirmBash, signal);
				case "read":
					return await execRead(args, cwd, config);
				case "write":
					return await execWrite(args, cwd);
				case "edit":
					return await execEdit(args, cwd);
				case "find":
					return await execFind(args, cwd, config);
				case "grep":
					return await execGrep(args, cwd, config);
				case "ls":
					return await execLs(args, cwd, config);
				default:
					return { content: `Unknown tool: ${name}`, isError: true };
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { content: message, isError: true };
		}
	};
}

// ============================================================================
// Bash
// ============================================================================

// Grace before a still-running command is *considered* for a live reveal (it
// also has to look like it's waiting for input — see the prompt heuristic in
// execBash). Long enough that ordinary fast commands exit first and never
// flash on screen; short enough to surface a real prompt promptly.
const BASH_LIVE_GRACE_MS = 300;

// If a command has been running for this long with *zero* PTY output, assume
// it's waiting for interactive input that bypasses the PTY (e.g. a program
// that opens /dev/tty directly). Fallback — PTY normally captures prompts.
const BASH_LIVE_SILENT_MS = 2000;

/** Strip ANSI escape sequences from PTY output for the model. */
function stripAnsi(s: string): string {
	const ESC = String.fromCharCode(0x1b);
	const BEL = String.fromCharCode(0x07);
	// biome-ignore lint/suspicious/noUselessEscapeInString: [ must be escaped in regex
	const csi = new RegExp(`${ESC}\[[0-9;]*[a-zA-Z]`, "g");
	// biome-ignore lint/suspicious/noUselessEscapeInString: ] must be escaped in regex
	const osc = new RegExp(`${ESC}\][^${BEL}]*${BEL}`, "g");
	return s.replace(csi, "").replace(osc, "");
}

async function execBash(
	args: Record<string, unknown>,
	cwd: string,
	config: AppConfig,
	confirmBash?: ConfirmBash,
	signal?: AbortSignal,
): Promise<ToolResult> {
	const command = String(args.command ?? "");
	const timeout = typeof args.timeout === "number" ? args.timeout : config.defaultBashTimeout;

	if (confirmBash) {
		const dangerReason = checkDangerousBash(command);
		if (dangerReason && !(await confirmBash(command, dangerReason))) {
			return {
				content: `Blocked: command matches a dangerous pattern (${dangerReason}) and was not confirmed. Ask the user to run it manually, or use a safer alternative.`,
				isError: true,
			};
		}
	}

	// /abort only ever cancelled the *next* LLM call — a bash command already
	// running (the most common thing someone actually wants to interrupt,
	// e.g. an accidental `sleep 300` or a long build) kept running to
	// completion regardless, since this function never saw the AbortSignal
	// at all. Wiring it in here means /abort actually kills it.
	if (signal?.aborted) {
		return { content: "Aborted before the command started.", isError: true };
	}

	const stdinSource = getStdinSource();

	return new Promise<ToolResult>((resolve) => {
		// Abstract child process — PTY when node-pty is installed (captures
		// interactive prompts like read -p, sudo, git push), pipe fallback
		// for release bundles where native modules aren't available.
		interface ChildHandle {
			kill(signal: string): void;
			write(data: string): void;
			onData(handler: (data: string) => void): void;
			onExit(handler: (info: { exitCode: number }) => void): void;
			cleanup(): void;
		}

		let child: ChildHandle;
		try {
			const ptyMod = require("node-pty");
			const proc = ptyMod.spawn("bash", ["-c", command], {
				name: "xterm-256color",
				cols: process.stdout.columns || 80,
				rows: process.stdout.rows || 24,
				cwd,
				env: process.env as Record<string, string>,
			});
			const listeners: ((data: string) => void)[] = [];
			proc.onData((d: string) => {
				for (const fn of listeners) fn(d);
			});
			child = {
				kill: (s) => proc.kill(s),
				write: (d) => proc.write(d),
				onData: (h) => listeners.push(h),
				onExit: (h) => proc.onExit(h),
				cleanup: () => {},
			};
		} catch {
			// ponytail: no node-pty — pipe fallback. Can't capture /dev/tty
			// prompts, but works for non-interactive commands.
			const proc = spawn("bash", ["-c", command], {
				cwd,
				env: process.env,
				stdio: ["pipe", "pipe", "pipe"],
			});
			const dataListeners: ((data: string) => void)[] = [];
			proc.stdout.on("data", (d: Buffer) => {
				for (const fn of dataListeners) fn(d.toString("utf-8"));
			});
			proc.stderr.on("data", (d: Buffer) => {
				for (const fn of dataListeners) fn(d.toString("utf-8"));
			});
			child = {
				kill: (s) => proc.kill(s as NodeJS.Signals),
				write: (d) => proc.stdin?.write(d),
				onData: (h) => dataListeners.push(h),
				onExit: (h) => proc.on("close", (code) => h({ exitCode: code ?? 1 })),
				cleanup: () => {
					if (stdinSource && proc.stdin) stdinSource.unpipe(proc.stdin);
				},
			};
			if (stdinSource && proc.stdin) stdinSource.pipe(proc.stdin, { end: false });
		}

		let rawOutput = "";
		let timedOut = false;
		let aborted = false;
		const maxBytes = config.maxToolOutputBytes;

		// Reveal a command live only when it looks like it's *waiting for input*,
		// not merely slow: still running past a short grace AND its latest output
		// isn't newline-terminated (a prompt leaves the cursor on the line —
		// "Enter value: "). Streaming logs from a long test/build end every line
		// with "\n", so they stay silent and aren't duplicated; a fast command
		// exits before the grace and is never shown. Output is always captured for
		// the model regardless — the live echo is the only extra.
		//
		// Suspending Ink (which blanks the composer to hand the terminal to the
		// child) is lazy too: only on go-live. A non-interactive command never
		// suspends, so its frame never flickers — it just resolves into the
		// transcript. On go-live we forward stdin and hold Ink suspended until the
		// child closes, then resolve *after* Ink resumes so the transcript redraws
		// onto a restored frame.
		let live = false;
		let graced = false;
		let tail = ""; // trailing bytes of combined output, to spot a waiting prompt
		let outputSeen = false; // any data from stdout or stderr at all
		const preLive: Buffer[] = [];
		let finalResult: ToolResult | null = null;
		let releaseSuspend: () => void = () => {};

		const goLive = () => {
			if (live) return;
			live = true;
			const suspended = new Promise<void>((r) => {
				releaseSuspend = r;
			});
			void suspendAndRun(async () => {
				// Ink is suspended and the composer has released stdin — only now
				// forward it to the PTY, so keystrokes don't briefly go to both.
				if (stdinSource) {
					stdinListener = (chunk: Buffer) => child.write(chunk.toString());
					stdinSource.on("data", stdinListener);
				}
				process.stderr.write(`\x1b[1m\x1b[36m$ ${command}\x1b[0m\n`);
				for (const chunk of preLive) process.stderr.write(chunk);
				preLive.length = 0;
				await suspended;
				process.stderr.write("\n");
			}).then(() => {
				if (finalResult) resolve(finalResult);
			});
		};
		const maybeGoLive = () => {
			if (!live && graced && tail.length > 0 && !tail.endsWith("\n")) goLive();
		};
		const graceTimer = setTimeout(() => {
			graced = true;
			maybeGoLive();
		}, BASH_LIVE_GRACE_MS);
		// Commands whose prompt goes to /dev/tty (read -p, sudo, git push)
		// produce zero pipe output — detect that and go live anyway.
		const silentTimer = setTimeout(() => {
			if (!outputSeen) goLive();
		}, BASH_LIVE_SILENT_MS);
		let stdinListener: ((chunk: Buffer) => void) | null = null;

		const onChunk = (data: string) => {
			outputSeen = true;
			if (rawOutput.length < maxBytes) rawOutput += data;
			if (live) {
				process.stderr.write(data);
				return;
			}
			preLive.push(Buffer.from(data, "utf-8"));
			tail = (tail + data).slice(-256);
			maybeGoLive();
		};

		child.onData((data: string) => onChunk(data));

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeout * 1000);

		const onAbort = () => {
			aborted = true;
			child.kill("SIGKILL");
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		const cleanup = () => {
			clearTimeout(timer);
			clearTimeout(graceTimer);
			clearTimeout(silentTimer);
			signal?.removeEventListener("abort", onAbort);
		};

		// Resolve directly when we never suspended; otherwise release the suspend
		// so suspendAndRun resumes Ink, and its .then resolves once the frame is back.
		const finish = (result: ToolResult) => {
			finalResult = result;
			if (live) releaseSuspend();
			else resolve(result);
		};

		child.onExit(({ exitCode }) => {
			if (stdinListener && stdinSource) stdinSource.removeListener("data", stdinListener);
			cleanup();
			let output = stripAnsi(rawOutput).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
			if (aborted) {
				output += "\n\nCommand aborted";
			} else if (timedOut) {
				const lower = output.toLowerCase();
				const hint =
					lower.includes("password") || lower.includes("username for") || output.trim() === ""
						? " (command may be waiting for interactive input — use non-interactive flags or ask the user to run it manually)"
						: "";
				output += `\n\nCommand timed out after ${timeout} seconds${hint}`;
			} else if (exitCode !== 0) {
				output += `\n\nProcess exited with code ${exitCode}`;
			}
			const lines = output.split("\n");
			if (lines.length > config.maxToolOutputLines) {
				const kept = lines.slice(-config.maxToolOutputLines);
				output = `[Showing last ${config.maxToolOutputLines} of ${lines.length} lines]\n${kept.join("\n")}`;
			}
			finish({ content: output || "(no output)", isError: aborted || timedOut || exitCode !== 0 });
		});
	});
}

// ============================================================================
// Read
// ============================================================================

const IMAGE_MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function execRead(args: Record<string, unknown>, cwd: string, config: AppConfig): Promise<ToolResult> {
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

// ============================================================================
// Write
// ============================================================================

async function execWrite(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
	const filePath = String(args.path ?? "");
	if (!filePath) return { content: "path is required", isError: true };
	const content = String(args.content ?? "");
	const absolutePath = resolvePath(filePath, cwd);

	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content, "utf-8");

	return { content: `Successfully wrote ${content.length} bytes to ${filePath}` };
}

// ============================================================================
// Edit
// ============================================================================

async function execEdit(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
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
		} else {
			out += escapeRegExp(ch);
		}
	}
	return out;
}

async function parseGitignore(root: string): Promise<GitignoreRule[]> {
	let text: string;
	try {
		text = await readFile(join(root, ".gitignore"), "utf-8");
	} catch {
		return [];
	}

	const rules: GitignoreRule[] = [];
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith("!")) continue;

		const dirOnly = line.endsWith("/");
		const pattern = dirOnly ? line.slice(0, -1) : line;
		const anchored = pattern.startsWith("/");
		const body = anchored ? pattern.slice(1) : pattern;
		const globBody = globToRegExpSource(body);

		rules.push({ regex: new RegExp(anchored ? `^${globBody}$` : `(^|/)${globBody}$`), dirOnly });
	}
	return rules;
}

function isGitignored(relPath: string, isDir: boolean, rules: GitignoreRule[]): boolean {
	return rules.some((rule) => (!rule.dirOnly || isDir) && rule.regex.test(relPath));
}

function globToFileRegExp(glob: string): RegExp {
	return new RegExp(`^${globToRegExpSource(glob)}$`);
}

/** Collect file paths under searchPath, skipping default-ignored dirs and cwd's .gitignore matches. */
async function walkFiles(cwd: string, searchPath: string, maxFiles: number = MAX_WALK_FILES): Promise<string[]> {
	const rules = await parseGitignore(cwd);
	const stack: string[] = [searchPath];
	const results: string[] = [];

	while (stack.length > 0 && results.length < maxFiles) {
		const dir = stack.pop()!;
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
			if (isGitignored(relPath, isDir, rules)) continue;

			if (isDir) stack.push(absPath);
			else if (entry.isFile()) results.push(absPath);
		}
	}
	return results;
}

// ============================================================================
// Find
// ============================================================================

async function execFind(args: Record<string, unknown>, cwd: string, _config: AppConfig): Promise<ToolResult> {
	const pattern = String(args.pattern ?? "");
	const searchPath = args.path ? resolvePath(String(args.path), cwd) : cwd;
	const limit = typeof args.limit === "number" ? args.limit : 1000;

	let absolutePaths: string[];
	try {
		// execFileSync runs the binary directly, no shell involved — unlike the
		// execSync(`fd ... '${pattern}' ...`) this replaced, a pattern
		// containing a single quote can't break out of the argument and inject
		// arbitrary shell commands (confirmed exploitable: a pattern like
		// `x'; echo pwned > /tmp/x; echo '` ran the injected command). Callers
		// don't get a say here — pattern/path come straight from a tool call
		// argument, so this can't rely on the input being well-behaved.
		const output = execFileSync("fd", ["--type", "f", "--max-results", String(limit), pattern, searchPath], {
			encoding: "utf-8",
			timeout: 10_000,
			cwd: searchPath,
		});
		absolutePaths = output.trim().split("\n").filter(Boolean);
	} catch (error) {
		// Unlike the old shell-based execSync, a missing binary now surfaces as
		// a real Node ENOENT (execFileSync spawns the binary directly, no shell
		// "command not found" translation to an exit code) — more reliable
		// than the exit-127 heuristic this used to need.
		if ((error as { code?: string }).code !== "ENOENT") {
			return { content: "No files found" };
		}
		// fd isn't installed — walk the tree ourselves, matching the pattern
		// against basenames like `find -name` does.
		const nameRe = globToFileRegExp(pattern);
		const allFiles = await walkFiles(cwd, searchPath);
		absolutePaths = allFiles.filter((p) => nameRe.test(basename(p))).slice(0, limit);
	}

	if (absolutePaths.length === 0) return { content: "No files found" };

	const relativePaths = absolutePaths.map((p) => (p.startsWith(cwd) ? p.slice(cwd.length + 1) : p));
	return { content: relativePaths.join("\n") };
}

// ============================================================================
// Grep
// ============================================================================

async function execGrep(args: Record<string, unknown>, cwd: string, config: AppConfig): Promise<ToolResult> {
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
	} catch (error) {
		// Unlike the old shell-based execSync, a missing binary now surfaces as
		// a real Node ENOENT rather than the shell's exit 127.
		if ((error as { code?: string }).code !== "ENOENT") {
			// rg ran but found nothing (or errored on the pattern) — same outcome
			// either way, no point re-running the same search by hand.
			return { content: "No matches found" };
		}

		// rg isn't installed — walk the tree and match content ourselves,
		// skipping node_modules/.git/etc and .gitignore matches.
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

// ============================================================================
// Ls
// ============================================================================

async function execLs(args: Record<string, unknown>, cwd: string, _config: AppConfig): Promise<ToolResult> {
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

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
