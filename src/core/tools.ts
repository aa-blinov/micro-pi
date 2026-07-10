import { execFileSync, spawn } from "node:child_process";
import { constants, type Dirent } from "node:fs";
import { access, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { Readable } from "node:stream";
import type { AppConfig } from "./config.ts";
import type { Message, Tool, Usage } from "./llm.ts";
import type { LoopConfig } from "./loop.ts";
import type { McpToolHandle } from "./mcp.ts";
import { checkDangerousBash } from "./permissions.ts";
import { getStdinSource, suspendAndRun } from "./stdin-manager.ts";
import type { SubagentPrompt } from "./subagents.ts";

// ============================================================================
// Tool definitions (OpenAI function calling format)
// ============================================================================

export function getToolDefinitions(personaNames?: string[], mainModel?: string, subagentModel?: string): Tool[] {
	const personaList =
		personaNames && personaNames.length > 0
			? `Available subagents: ${personaNames.join(", ")}. Defaults to "${personaNames.includes("worker") ? "worker" : personaNames[0]}" if omitted.`
			: "";
	const modelInfo = subagentModel && subagentModel !== mainModel ? ` Subagent model: ${subagentModel}.` : "";

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
		...(personaNames?.length
			? [
					{
						type: "function" as const,
						function: {
							name: "task",
							description:
								"Delegate a task to a subagent with an isolated context. " +
								"The subagent runs independently — its intermediate tool calls do not appear in your context. " +
								"Only the final result is returned to you. " +
								`Use for parallel work, research, or isolating complex exploration. ${personaList}${modelInfo}`,
							parameters: {
								type: "object",
								properties: {
									assignment: {
										type: "string",
										description: "Complete, self-contained task description for the subagent",
									},
									subagent: {
										type: "string",
										description: "Subagent name (optional). Example: 'worker'",
									},
								},
								required: ["assignment"],
							},
						},
					},
				]
			: []),
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
	/** Usage from subagent execution (task tool only). */
	subagentUsage?: Usage;
}

export type ToolExecutor = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;

/** Asked before running a bash command that matches a known-dangerous pattern. Return false to block it. */
export type ConfirmBash = (command: string, reason: string) => Promise<boolean>;

/**
 * Max subagents allowed to run at once. The model can emit many `task` calls
 * in a single batch (executed via Promise.all in the loop); without a cap each
 * one spawns a full agent loop with its own LLM traffic and child processes,
 * which blows rate limits and memory. Excess spawns queue on this semaphore.
 */
const MAX_CONCURRENT_SUBAGENTS = 10;

/** Thrown by Semaphore.acquire when the wait is cancelled via its signal. */
class AbortError extends Error {
	constructor() {
		super("Aborted while queued");
		this.name = "AbortError";
	}
}

/**
 * Minimal FIFO counting semaphore for bounding subagent concurrency.
 * `acquire` is abort-aware: a caller queued behind the limit that gets its
 * signal aborted is removed from the queue and rejected immediately, instead
 * of holding on until a slot frees. This lets Esc cancel queued subagents at
 * once rather than draining them one released slot at a time.
 */
class Semaphore {
	private active = 0;
	private readonly waiters: Array<() => void> = [];
	constructor(private readonly max: number) {}
	acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(new AbortError());
		if (this.active < this.max) {
			this.active++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			const waiter = (): void => {
				cleanup();
				resolve();
			};
			const onAbort = (): void => {
				const i = this.waiters.indexOf(waiter);
				// Only reject if we're still queued — if release() already handed us
				// the slot, `waiter` ran first and removed the listener, so this is a
				// no-op. A queued waiter never incremented `active`, so nothing to free.
				if (i >= 0) this.waiters.splice(i, 1);
				cleanup();
				reject(new AbortError());
			};
			const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
			this.waiters.push(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
	release(): void {
		const next = this.waiters.shift();
		if (next) {
			// Hand the slot straight to the next waiter — active stays constant.
			next();
		} else {
			this.active--;
		}
	}
}

const subagentSemaphore = new Semaphore(MAX_CONCURRENT_SUBAGENTS);

/**
 * Serializes bash-confirmation prompts across concurrently running subagents.
 * Confirmations read the single shared terminal/stdin, so two subagents asking
 * at once would race for it. Chaining forces one prompt to fully resolve before
 * the next begins. The chain never rejects (errors are swallowed into the tail)
 * so one failed confirmation can't wedge the queue.
 */
let confirmChain: Promise<unknown> = Promise.resolve();
function serializeConfirm(confirm: ConfirmBash | undefined): ConfirmBash | undefined {
	if (!confirm) return confirm;
	return (command: string, reason: string): Promise<boolean> => {
		const run = confirmChain.then(() => confirm(command, reason));
		confirmChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
}

async function execTask(
	args: Record<string, unknown>,
	cwd: string,
	config: AppConfig,
	deps: TaskExecutorDeps,
	signal?: AbortSignal,
): Promise<ToolResult & { subagentUsage?: Usage }> {
	const assignment = typeof args.assignment === "string" ? args.assignment.trim() : "";
	if (!assignment) return { content: "Missing `assignment`.", isError: true };

	const subagentName = typeof args.subagent === "string" ? args.subagent.trim() : "";
	// Default (no subagent given): prefer the general-purpose "worker" explicitly
	// rather than "first in the sorted list", so adding another subagent whose
	// name sorts earlier can't silently steal the default.
	const defaultSubagent = deps.subagentPrompts?.find((p) => p.name === "worker") ?? deps.subagentPrompts?.[0];
	const subagent = subagentName ? deps.subagentPrompts?.find((p) => p.name === subagentName) : defaultSubagent;

	if (subagentName && !subagent) {
		const available = deps.subagentPrompts?.map((p) => p.name).join(", ") ?? "(none)";
		return { content: `Unknown subagent "${subagentName}". Available: ${available}`, isError: true };
	}

	// The assignment lives only in the user message — the system prompt carries
	// the subagent's role. Duplicating it in both wastes tokens and gives the
	// model two competing copies of the task.
	const childSystemPrompt = subagent?.systemPrompt ?? "You are a worker agent. Complete the assigned task.";

	const childMessages: Message[] = [{ role: "user", content: assignment }];

	// Capture usage from subagent events
	const subagentUsage: Usage = {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
	};

	// Reason from the subagent's final `end` event. Anything other than "stop"
	// (aborted, disconnected, error) means the run did not complete cleanly and
	// must be surfaced as an error rather than passed off as a valid result.
	let endReason = "stop";

	// Bound concurrency: excess subagents queue here until a slot frees up.
	// Abort-aware — if cancelled while queued, bail out before holding a slot.
	try {
		await subagentSemaphore.acquire(signal);
	} catch {
		return {
			content: "Subagent did not complete successfully (aborted):\n\n(cancelled before start)",
			isError: true,
			subagentUsage,
		};
	}
	let finalMessages: Message[];
	try {
		finalMessages = await deps.runAgentLoop(childMessages, {
			config,
			model: deps.model,
			cwd,
			systemPrompt: childSystemPrompt,
			onEvent: (event) => {
				if (event.type === "usage") {
					subagentUsage.promptTokens += event.usage.promptTokens;
					subagentUsage.completionTokens += event.usage.completionTokens;
					subagentUsage.totalTokens += event.usage.totalTokens;
					if (event.usage.cacheReadTokens) {
						subagentUsage.cacheReadTokens = (subagentUsage.cacheReadTokens ?? 0) + event.usage.cacheReadTokens;
					}
					if (event.usage.cacheWriteTokens) {
						subagentUsage.cacheWriteTokens = (subagentUsage.cacheWriteTokens ?? 0) + event.usage.cacheWriteTokens;
					}
					if (event.usage.uncachedTokens) {
						subagentUsage.uncachedTokens = (subagentUsage.uncachedTokens ?? 0) + event.usage.uncachedTokens;
					}
					// Provider-reported cost (e.g. OpenRouter) must be folded in too,
					// otherwise the subagent's spend silently vanishes from the
					// session's cost total — tokens were propagated but dollars weren't.
					if (event.usage.cost) {
						subagentUsage.cost = (subagentUsage.cost ?? 0) + event.usage.cost;
					}
				} else if (event.type === "end") {
					endReason = event.reason;
				}
			},
			signal,
			// Serialize confirmations so parallel subagents don't race the terminal.
			confirmBash: serializeConfirm(deps.confirmBash),
			mcpTools: deps.mcpTools,
			mcpToolIndex: deps.mcpToolIndex,
			// ponytail: no personas/currentPersona/subagentModel — child can't delegate further
		});
	} finally {
		subagentSemaphore.release();
	}

	// Extract the final assistant response
	const lastAssistant = [...finalMessages].reverse().find((m) => m.role === "assistant");
	const text = typeof lastAssistant?.content === "string" ? lastAssistant.content.trim() : "";

	// Surface failures instead of passing them off as a clean (but empty) result.
	if (endReason !== "stop") {
		const detail = text || "(no output produced)";
		return {
			content: `Subagent did not complete successfully (${endReason}):\n\n${detail}`,
			isError: true,
			subagentUsage,
		};
	}
	if (!text) {
		return { content: "Subagent completed but produced no output.", isError: true, subagentUsage };
	}
	return { content: text, subagentUsage };
}

export interface TaskExecutorDeps {
	model: string;
	/** Subagent prompts available for the task tool. */
	subagentPrompts?: SubagentPrompt[];
	mcpTools?: Tool[];
	mcpToolIndex?: Map<string, McpToolHandle>;
	confirmBash?: ConfirmBash;
	/** Main agent model, shown in task tool description for transparency. */
	mainModel?: string;
	/** Model override for subagents (falls back to main model if undefined). */
	subagentModel?: string;
	/** Injected to avoid circular dependency with loop.ts. */
	runAgentLoop: (messages: Message[], config: LoopConfig) => Promise<Message[]>;
}

export function createToolExecutor(
	cwd: string,
	config: AppConfig,
	confirmBash?: ConfirmBash,
	taskDeps?: TaskExecutorDeps,
): ToolExecutor {
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
				case "task":
					if (!taskDeps)
						return { content: "Task tool not available — no dependencies configured.", isError: true };
					return await execTask(args, cwd, config, taskDeps, signal);
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

// Known non-interactive command prefixes — these never need live terminal
// output (their streaming logs end every line with "\n", but slow builds
// can still trigger the tail heuristic).  Matched against the trimmed
// command string so leading whitespace / env vars don't fool the check.
const NON_LIVE_PATTERNS: RegExp[] = [
	// JS/TS ecosystem
	/^npm\s+(run|test|ci|install|build|start|exec|publish|pack|version)/,
	/^npx\s/,
	/^node\s/,
	/^yarn\b/,
	/^pnpm\b/,
	/^bun\s+(run|test|install|build|x)\b/,
	/^turbo\s+(run|build|test|lint)/,
	/^nx\s+(run|build|test|lint|affected)/,
	/^vitest\b/,
	/^jest\b/,
	/^mocha\b/,
	/^eslint\b/,
	/^prettier\b/,
	/^tsc\b/,
	/^esbuild\b/,
	/^vite\s+build/,
	/^webpack\b/,
	/^rollup\b/,
	// Build tools
	/^make\b/,
	/^cmake\b/,
	/^ninja\b/,
	/^meson\b/,
	/^bazel\b/,
	/^gradle[w]?\b/,
	/^mvn\b/,
	/^ant\b/,
	// Rust
	/^cargo\s+(build|test|check|run|clippy|fmt|doc|bench|publish|install)/,
	/^rustup\b/,
	// Go
	/^go\s+(build|test|run|install|vet|fmt|mod|generate|tool|get|clean)/,
	// C/C++
	/^gcc\b/,
	/^g\+\+\b/,
	/^clang\b/,
	/^clang\+\+\b/,
	// Python
	/^python[3]?\s+(-m\s+)?(pytest|unittest|tox|setup\.py|build|compile)/,
	/^pip[3]?\s+(install|wheel|download|compile)/,
	/^poetry\b/,
	/^pipenv\b/,
	/^conda\b/,
	/^mypy\b/,
	/^ruff\b/,
	/^black\b/,
	/^flake8\b/,
	/^pylint\b/,
	/^isort\b/,
	/^uv\s+(pip|run|build|sync|tool)/,
	// Ruby
	/^bundle\b/,
	/^rake\b/,
	/^gem\s+(install|build)/,
	// PHP
	/^composer\b/,
	// Docker / containers
	/^docker\s+(build|compose|pull|push|tag|save|load)/,
	/^podman\b/,
	// Git (non-interactive subcommands)
	/^git\s+(clone|pull|push|fetch|stash|branch|checkout|merge|rebase|log|diff|status|add|commit|remote|tag|reset|cherry-pick|revert|bisect|clean|gc|fsck|worktree)/,
	// Package managers (system)
	/^brew\b/,
	/^apt(-get)?\b/,
	/^yum\b/,
	/^dnf\b/,
	/^pacman\b/,
	/^apk\b/,
	/^zypper\b/,
	// Network
	/^curl\b/,
	/^wget\b/,
	/^http\b/,
	// Misc CI / tooling
	/^terraform\b/,
	/^ansible\b/,
	/^kubectl\b/,
	/^helm\b/,
	/^rsync\b/,
	/^scp\b/,
	/^tar\b/,
	/^zip\b/,
	/^unzip\b/,
];

function isNonLiveCommand(cmd: string): boolean {
	const trimmed = cmd.replace(/^\s*(?:\w+=\S+\s+)*/, ""); // strip leading ENV=val
	return NON_LIVE_PATTERNS.some((re) => re.test(trimmed));
}

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

function createBashProcess(command: string, cwd: string, stdinSource: Readable | null): ChildHandle {
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
		return {
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
			detached: true, // separate process group so kill(-pid) wipes all children
		});
		const dataListeners: ((data: string) => void)[] = [];
		proc.stdout.on("data", (d: Buffer) => {
			for (const fn of dataListeners) fn(d.toString("utf-8"));
		});
		proc.stderr.on("data", (d: Buffer) => {
			for (const fn of dataListeners) fn(d.toString("utf-8"));
		});
		const handle: ChildHandle = {
			kill: (s) => process.kill(-proc.pid!, s as NodeJS.Signals),
			write: (d) => proc.stdin?.write(d),
			onData: (h) => dataListeners.push(h),
			onExit: (h) => proc.on("close", (code) => h({ exitCode: code ?? 1 })),
			cleanup: () => {
				if (stdinSource && proc.stdin) stdinSource.unpipe(proc.stdin);
			},
		};
		if (stdinSource && proc.stdin) stdinSource.pipe(proc.stdin, { end: false });
		return handle;
	}
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
		return { content: "[ABORTED] Command was interrupted by user (before execution started).", isError: true };
	}

	const stdinSource = getStdinSource();

	return new Promise<ToolResult>((resolve) => {
		const child = createBashProcess(command, cwd, stdinSource);

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
			if (live || isNonLiveCommand(command)) return;
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
			// Safety net: if onExit never fires (D-state / hung I/O),
			// force-resolve after 5 s instead of hanging forever.
			setTimeout(() => {
				if (!finalResult)
					finish({
						content: "[ABORTED] Command was interrupted by user (forced — process did not exit).",
						isError: true,
					});
			}, 5000);
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
			const prefix = aborted
				? "[ABORTED] Command was interrupted by user.\n\n"
				: timedOut
					? (() => {
							const lower = output.toLowerCase();
							const hint =
								lower.includes("password") || lower.includes("username for") || output.trim() === ""
									? " (command may be waiting for interactive input — use non-interactive flags or ask the user to run it manually)"
									: "";
							return `[TIMED OUT] after ${timeout} seconds${hint}.\n\n`;
						})()
					: "";
			if (exitCode !== 0 && !aborted && !timedOut) {
				output += `\n\nProcess exited with code ${exitCode}`;
			}
			const lines = output.split("\n");
			if (lines.length > config.maxToolOutputLines) {
				const kept = lines.slice(-config.maxToolOutputLines);
				output = `[Showing last ${config.maxToolOutputLines} of ${lines.length} lines]\n${kept.join("\n")}`;
			}
			finish({ content: prefix + (output || "(no output)"), isError: aborted || timedOut || exitCode !== 0 });
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

// ============================================================================
// Find
// ============================================================================

async function execFind(args: Record<string, unknown>, cwd: string, _config: AppConfig): Promise<ToolResult> {
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
