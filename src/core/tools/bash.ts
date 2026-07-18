/**
 * The `bash` tool — runs a shell command and returns its output.
 *
 * stdin is always "ignore" (EOF) — any command waiting for input exits
 * immediately instead of hanging. This is how OpenCode handles it: no PTY,
 * no prompt detection, no interactive command blocking at runtime.
 *

 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config.ts";
import { checkDangerousBash } from "../permissions.ts";
import type { ConfirmBash, ToolResult } from "./shared.ts";

/** Strip ANSI escape sequences from output. */
function stripAnsi(s: string): string {
	const ESC = String.fromCharCode(0x1b);
	const BEL = String.fromCharCode(0x07);
	// biome-ignore lint/suspicious/noUselessEscapeInString: [ must be escaped in regex
	const csi = new RegExp(`${ESC}\[[0-9;]*[a-zA-Z]`, "g");
	// biome-ignore lint/suspicious/noUselessEscapeInString: ] must be escaped in regex
	const osc = new RegExp(`${ESC}\][^${BEL}]*${BEL}`, "g");
	return s.replace(csi, "").replace(osc, "");
}

export interface BashResolution {
	path: string;
	/** Set when the resolution is a known-bad fallback the user should hear about. */
	warning?: string;
}

/** Run a command and return trimmed stdout, or null on any failure. */
export type RunCommand = (file: string, args: string[]) => string | null;

/**
 * Git for Windows' InstallPath from the registry — the installer writes
 * `Software\GitForWindows\InstallPath` specifically so third-party tools can
 * find it (per-user installs land in HKCU, machine-wide in HKLM). This is how
 * VS Code locates Git Bash, and unlike hardcoded paths it survives installs
 * on other drives. Read via `reg.exe query` to avoid a registry dependency.
 */
function gitBashFromRegistry(run: RunCommand, exists: (p: string) => boolean): string | null {
	for (const hive of ["HKCU", "HKLM"]) {
		const out = run("reg.exe", ["query", `${hive}\\Software\\GitForWindows`, "/v", "InstallPath"]);
		const match = out?.match(/InstallPath\s+REG_SZ\s+(.+)/);
		const installPath = match?.[1]?.trim();
		if (!installPath) continue;
		for (const rel of [join("bin", "bash.exe"), join("usr", "bin", "bash.exe")]) {
			const candidate = join(installPath, rel);
			if (exists(candidate)) return candidate;
		}
	}
	return null;
}

/**
 * Derive Git Bash from wherever `git` on PATH lives: <root>\cmd\git.exe →
 * <root>\bin\bash.exe. Catches custom locations that are in PATH but neither
 * in the registry nor at a known path (portable installs). Shim launchers
 * (scoop) don't sit inside a Git root — the exists() check rejects those.
 */
function gitBashFromPath(run: RunCommand, exists: (p: string) => boolean): string | null {
	const out = run("where.exe", ["git.exe"]);
	if (!out) return null;
	for (const line of out.split(/\r?\n/)) {
		const gitExe = line.trim();
		if (!gitExe) continue;
		const root = join(gitExe, "..", "..");
		for (const rel of [join("bin", "bash.exe"), join("usr", "bin", "bash.exe")]) {
			const candidate = join(root, rel);
			if (exists(candidate)) return candidate;
		}
	}
	return null;
}

/**
 * Resolve the bash executable, pure and injectable for tests.
 *
 * On win32 a bare `bash` from PATH usually resolves to the WSL shim
 * (System32\bash.exe), which runs commands in a separate Linux environment:
 * piped output frequently never arrives, and the Windows-side toolchain
 * (python, node, the project's own venv) isn't there — the "no output from
 * bash tool" report. Git Bash runs win32-native, so it's preferred.
 *
 * Order: CAST_BASH env override (used verbatim — a wrong value surfaces as a
 * spawn error, which is the debuggable behavior an explicit override wants) →
 * GitForWindows registry key (HKCU then HKLM — the canonical discovery hook
 * the installer provides, covers any install drive) → known install paths
 * (admin 64/32-bit, the no-admin per-user default under LocalAppData, scoop)
 * → derivation from `git` on PATH → PATH `bash` with a warning on win32,
 * since that's the WSL failure mode we tried to avoid.
 */
export function resolveBashFrom(
	platform: NodeJS.Platform,
	env: Record<string, string | undefined>,
	exists: (p: string) => boolean,
	run: RunCommand = () => null,
): BashResolution {
	const override = env.CAST_BASH?.trim();
	if (override) return { path: override };

	if (platform !== "win32") return { path: "bash" };

	const fromRegistry = gitBashFromRegistry(run, exists);
	if (fromRegistry) return { path: fromRegistry };

	const candidates = [
		join(env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
		join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
		join(env.LOCALAPPDATA || "", "Programs", "Git", "bin", "bash.exe"),
		join(env.USERPROFILE || "", "scoop", "apps", "git", "current", "bin", "bash.exe"),
	];
	for (const candidate of candidates) {
		if (candidate && exists(candidate)) return { path: candidate };
	}

	const fromPath = gitBashFromPath(run, exists);
	if (fromPath) return { path: fromPath };

	return {
		path: "bash",
		warning:
			"Git Bash not found — falling back to `bash` from PATH, which on Windows is usually the WSL shim " +
			"(commands may produce no output and can't see the Windows toolchain). " +
			"Install Git for Windows, or set CAST_BASH to a native bash.exe.",
	};
}

/** execFileSync wrapper for registry/where lookups — null on any failure. */
function runCommandSync(file: string, args: string[]): string | null {
	try {
		return execFileSync(file, args, { encoding: "utf-8", timeout: 3000, windowsHide: true }).trim();
	} catch {
		return null;
	}
}

let cachedBash: BashResolution | undefined;
/** Warning is surfaced once per process, on the first bash call. */
let warningShown = false;
function resolveBash(): BashResolution {
	cachedBash ??= resolveBashFrom(process.platform, process.env, existsSync, runCommandSync);
	return cachedBash;
}

/**
 * The process-wide bash resolution, for startup to surface the WSL-fallback
 * warning to the *user* before any command runs — the in-result warning only
 * reaches whoever reads the first bash tool output, which is mostly the model.
 */
export function getBashResolution(): BashResolution {
	return resolveBash();
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

	// Block dangerous commands (rm -rf, sudo, etc.)
	if (confirmBash) {
		const dangerReason = checkDangerousBash(command);
		if (dangerReason && !(await confirmBash(command, dangerReason))) {
			return {
				content: `Blocked: command matches a dangerous pattern (${dangerReason}) and was not confirmed. Ask the user to run it manually, or use a safer alternative.`,
				isError: true,
			};
		}
	}

	if (signal?.aborted) {
		return { content: "[ABORTED] Command was interrupted by user (before execution started).", isError: true };
	}

	const bash = resolveBash();
	let warnPrefix = "";
	if (bash.warning && !warningShown) {
		warningShown = true;
		warnPrefix = `[warning] ${bash.warning}\n\n`;
	}

	return new Promise<ToolResult>((resolve) => {
		// stdin: "ignore" — the key pattern from OpenCode. Any command waiting
		// for input gets EOF and exits immediately. No PTY, no prompt detection.
		const proc = spawn(bash.path, ["-c", command], {
			cwd,
			env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat" },
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});

		let rawOutput = "";
		let timedOut = false;
		let aborted = false;
		const maxBytes = config.maxToolOutputBytes;

		proc.stdout.on("data", (d: Buffer) => {
			if (rawOutput.length < maxBytes) rawOutput += d.toString("utf-8");
		});
		proc.stderr.on("data", (d: Buffer) => {
			if (rawOutput.length < maxBytes) rawOutput += d.toString("utf-8");
		});

		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-proc.pid!, "SIGKILL");
			} catch {
				// already dead
			}
		}, timeout * 1000);

		const onAbort = () => {
			aborted = true;
			try {
				process.kill(-proc.pid!, "SIGKILL");
			} catch {
				// already dead
			}
			setTimeout(() => {
				if (!finalResult)
					resolve({
						content: "[ABORTED] Command was interrupted by user (forced — process did not exit).",
						isError: true,
					});
			}, 5000);
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		let finalResult: ToolResult | null = null;

		// Spawn failure (bash executable missing — e.g. a wrong CAST_BASH):
		// without this handler the promise never settles and Node throws an
		// unhandled 'error' event instead of the model seeing what went wrong.
		proc.on("error", (err) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (finalResult) return;
			const result: ToolResult = {
				content: `${warnPrefix}Failed to start bash ("${bash.path}"): ${err.message}`,
				isError: true,
			};
			finalResult = result;
			resolve(result);
		});

		proc.on("close", (exitCode) => {
			if (finalResult) return;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);

			let output = stripAnsi(rawOutput).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
			const prefix = aborted
				? "[ABORTED] Command was interrupted by user.\n\n"
				: timedOut
					? `[TIMED OUT] after ${timeout} seconds. If this command needs more time, retry with a larger timeout.\n\n`
					: "";
			if (exitCode !== 0 && !aborted && !timedOut) {
				output += `\n\nProcess exited with code ${exitCode}`;
			}
			const lines = output.split("\n");
			if (lines.length > config.maxToolOutputLines) {
				const kept = lines.slice(-config.maxToolOutputLines);
				output = `[Showing last ${config.maxToolOutputLines} of ${lines.length} lines]\n${kept.join("\n")}`;
			}
			const result: ToolResult = {
				content: warnPrefix + prefix + (output || "(no output)"),
				isError: aborted || timedOut || exitCode !== 0,
			};
			finalResult = result;
			resolve(result);
		});
	});
}
