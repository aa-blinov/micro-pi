/**
 * The `bash` tool — runs a shell command, optionally revealing it live in the
 * terminal when it looks like it's waiting for interactive input. Uses node-pty
 * to capture prompts (read -p, sudo, git push) when available, with a plain
 * pipe fallback for release bundles where the native module isn't present.
 */

import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { AppConfig } from "../config.ts";
import { checkDangerousBash } from "../permissions.ts";
import { getStdinSource, suspendAndRun } from "../stdin-manager.ts";
import type { ConfirmBash, ToolResult } from "./shared.ts";

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

export async function execBash(
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
