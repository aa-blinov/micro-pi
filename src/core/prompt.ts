import type { AppConfig } from "./config.ts";
import { isRetryableStreamError } from "./llm.ts";
import { type AgentEvent, runAgentLoop } from "./loop.ts";
import type { McpSetupResult } from "./mcp.ts";
import { ask, type createRl } from "./readline.ts";
import type { AgentRunner } from "./runner.ts";
import { addUsage, appendMessage, type SessionState, saveSession } from "./session.ts";
import type { PermissionMode } from "./settings.ts";

// ============================================================================
// Prompt execution
// ============================================================================

/**
 * Gate for bash commands matching a known-dangerous pattern (see
 * permissions.ts). In "bypass" mode, or when stdin isn't a TTY (nothing to
 * prompt), this either allows everything or blocks outright — never hangs
 * waiting for input that may never come.
 */
async function confirmDangerousBash(
	rl: ReturnType<typeof createRl>,
	permissionMode: PermissionMode,
	command: string,
	reason: string,
): Promise<boolean> {
	if (permissionMode === "bypass") return true;
	if (!process.stdin.isTTY) {
		console.log(
			`\n\x1b[31m[Blocked: command looks dangerous (${reason}) and can't be confirmed non-interactively.]\x1b[0m`,
		);
		console.log("Run interactively to confirm it, or use /permissions bypass beforehand.");
		return false;
	}
	console.log(`\n\x1b[33m[Dangerous command detected: ${reason}]\x1b[0m`);
	console.log(`  ${command}`);
	const answer = (await ask(rl, "Allow this command? [y/N] ")).trim().toLowerCase();
	return answer === "y" || answer === "yes";
}

export async function runPrompt(
	input: string,
	session: SessionState,
	config: AppConfig,
	cwd: string,
	systemPrompt: string,
	runner: AgentRunner,
	rl: ReturnType<typeof createRl>,
	permissionMode: PermissionMode,
	mcpResult: McpSetupResult,
): Promise<void> {
	appendMessage(session, { role: "user", content: input });

	const ac = new AbortController();
	runner.startRun(ac);

	// process.stdout.write instead of console.log: console.log appends
	// an extra \n that double-spaces the output when readline redraws
	// its prompt after the abort.
	//
	// Goes through runner.abort() (not ac.abort() directly) so a /steer or
	// /queue message queued right before Ctrl+C gets cleared the same
	// way /abort and /quit clear it — otherwise it would silently leak into
	// the next, unrelated prompt (see runner.ts's abort()).
	const onSigint = () => {
		runner.abort();
		process.stdout.write("\n[Interrupted]\n");
	};
	process.on("SIGINT", onSigint);

	// A connection dying mid-stream *after* some content already arrived can
	// throw as an uncaught exception from deep inside the HTTP client instead
	// of a normal rejection (confirmed by testing — see isRetryableStreamError
	// in llm.ts). We can't resume the hung call that triggered it, but we can
	// avoid losing the session to a raw crash: save it and exit cleanly.
	const onUncaughtStreamError = (error: Error) => {
		if (!isRetryableStreamError(error)) {
			// Not the mid-stream-drop bug this handler exists for — some other,
			// unrelated exception happened to surface while this was the active
			// listener. Re-throwing from inside an uncaughtException handler
			// doesn't reliably restore Node's normal crash behavior: confirmed
			// (Node 26) it hits a different, undocumented internal path — exit
			// code 7 ("Internal Exception Handler Run-Time Failure") instead of
			// the standard 1 a plain unhandled exception gets with no listener
			// at all. Node's own docs warn against relying on rethrow here.
			// Print + save + exit explicitly instead, so an unrelated bug
			// crashes the same deterministic way regardless of Node version.
			console.error(error);
			saveSession(session);
			console.error(`Session saved: ${session.id}.`);
			process.exit(1);
		}
		console.error(`\n\x1b[31m[Connection dropped mid-response: ${error.message}]\x1b[0m`);
		saveSession(session);
		console.error(`Session saved: ${session.id}. Restart cast to continue.`);
		process.exit(1);
	};
	process.on("uncaughtException", onUncaughtStreamError);

	let fullResponse = "";
	let wasThinking = false;
	// Printed once per user turn, right before the agent's first bit of
	// visible output (thinking or token) — distinguishes the agent's turn
	// from the "[user]" prompt (see index.ts's rl.setPrompt) without
	// repeating the label after every tool round-trip within the same turn.
	let printedAgentLabel = false;
	const AGENT_COLOR = "\x1b[32m";
	const printAgentLabelOnce = (): void => {
		if (printedAgentLabel) return;
		printedAgentLabel = true;
		process.stdout.write(`${AGENT_COLOR}[agent]\x1b[0m `);
	};

	const messages = await runAgentLoop(session.messages, {
		config,
		model: session.model,
		cwd,
		systemPrompt,
		signal: ac.signal,
		steeringQueue: runner.steeringQueue,
		followUpQueue: runner.followUpQueue,
		confirmBash: (command, reason) => confirmDangerousBash(rl, permissionMode, command, reason),
		mcpTools: mcpResult.toolDefinitions,
		mcpToolIndex: mcpResult.toolIndex,
		lastPromptTokens: session.lastPromptTokens,
		onEvent: (event: AgentEvent) => {
			switch (event.type) {
				case "thinking":
					printAgentLabelOnce();
					wasThinking = true;
					process.stdout.write(`\x1b[90m${event.text}\x1b[0m`);
					break;
				case "token":
					printAgentLabelOnce();
					if (wasThinking) {
						process.stdout.write("\n\n");
						wasThinking = false;
					}
					process.stdout.write(`${AGENT_COLOR}${event.text}\x1b[0m`);
					fullResponse += event.text;
					break;
				case "tool_start": {
					let argsDisplay = "";
					try {
						const parsed = JSON.parse(event.args);
						argsDisplay = Object.entries(parsed)
							.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
							.join(", ");
					} catch {
						argsDisplay = event.args.slice(0, 200);
					}
					process.stdout.write(`\n\x1b[36m[tool: ${event.name}]\x1b[0m ${argsDisplay}\n`);
					break;
				}
				case "tool_end": {
					const status = event.result.isError ? "\x1b[31merror\x1b[0m" : "\x1b[32mok\x1b[0m";
					const output = event.result.content.slice(0, 300);
					const truncated = event.result.content.length > 300 ? "..." : "";
					process.stdout.write(`\x1b[36m[tool: ${event.name}]\x1b[0m ${status}\n${output}${truncated}\n`);
					break;
				}
				case "steering_injected":
					process.stdout.write(`\n\x1b[33m[Steering: ${event.messages.length} message(s) injected]\x1b[0m\n`);
					break;
				case "followup_injected":
					process.stdout.write(`\n\x1b[33m[Follow-up: ${event.messages.length} message(s) injected]\x1b[0m\n`);
					break;
				case "compaction":
					process.stdout.write(
						`\n\x1b[33m[Compacted: ${event.messagesCompacted} msgs, ${event.tokensBefore} tokens]\x1b[0m\n`,
					);
					break;
				case "compaction_failed":
					process.stdout.write(
						`\n\x1b[31m[Compaction failed (${event.reason}) — continuing without compacting; history was not modified]\x1b[0m\n`,
					);
					break;
				case "retry":
					process.stdout.write(
						`\n\x1b[33m[Retrying after transient error (${event.attempt}/${event.maxAttempts}): ${event.reason}]\x1b[0m\n`,
					);
					break;
				case "usage": {
					addUsage(session, event.usage);
					const costSuffix = event.usage.cost ? `, $${event.usage.cost.toFixed(4)}` : "";
					const cacheParts: string[] = [];
					if (event.usage.cacheReadTokens) cacheParts.push(`${event.usage.cacheReadTokens} cached`);
					if (event.usage.cacheWriteTokens) cacheParts.push(`${event.usage.cacheWriteTokens} cache write`);
					const cacheSuffix = cacheParts.length ? `, ${cacheParts.join(", ")}` : "";
					process.stdout.write(
						`\n\x1b[90m[tokens: ${event.usage.promptTokens} in + ${event.usage.completionTokens} out = ${event.usage.totalTokens} total${cacheSuffix}${costSuffix}]\x1b[0m\n`,
					);
					break;
				}
				case "end":
					if (event.reason !== "stop" && event.reason !== "tool_calls") {
						process.stdout.write(`\n[${event.reason}]\n`);
					}
					break;
				case "error":
					console.error(`\n\x1b[31mError: ${event.message}\x1b[0m`);
					break;
			}
		},
	});

	session.messages = messages;
	if (fullResponse) process.stdout.write("\n");
	process.off("SIGINT", onSigint);
	process.off("uncaughtException", onUncaughtStreamError);
	runner.endRun();
}
