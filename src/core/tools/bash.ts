/**
 * The `bash` tool — runs a shell command and returns its output.
 *
 * stdin is always "ignore" (EOF) — any command waiting for input exits
 * immediately instead of hanging. This is how OpenCode handles it: no PTY,
 * no prompt detection, no interactive command blocking at runtime.
 *
 * Static checkInteractiveBash still catches obvious cases (ssh, vim, etc.)
 * before they even spawn, as a UX improvement (instant error vs exit code 1).
 */

import { spawn } from "node:child_process";
import type { AppConfig } from "../config.ts";
import { checkDangerousBash, checkInteractiveBash } from "../permissions.ts";
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

	// Static interactive check — instant error for obvious cases (ssh, vim, etc.)
	const interactiveReason = checkInteractiveBash(command);
	if (interactiveReason) {
		return {
			content: `Blocked: ${interactiveReason}. Use non-interactive alternatives (e.g. \`git commit -m "msg"\`, \`git push --no-edit\`).`,
			isError: true,
		};
	}

	if (signal?.aborted) {
		return { content: "[ABORTED] Command was interrupted by user (before execution started).", isError: true };
	}

	return new Promise<ToolResult>((resolve) => {
		// stdin: "ignore" — the key pattern from OpenCode. Any command waiting
		// for input gets EOF and exits immediately. No PTY, no prompt detection.
		const proc = spawn("bash", ["-c", command], {
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

		proc.on("close", (exitCode) => {
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
				content: prefix + (output || "(no output)"),
				isError: aborted || timedOut || exitCode !== 0,
			};
			finalResult = result;
			resolve(result);
		});
	});
}
