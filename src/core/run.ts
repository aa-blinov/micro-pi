import { EOL } from "node:os";
import { noPickers } from "../pickers/no-pickers.ts";
import type { AgentEvent } from "./loop.ts";
import { runAgentLoop } from "./loop.ts";
import { closeMcpConnections } from "./mcp.ts";
import { addUsage, appendMessage, type SessionState, saveSession } from "./session.ts";
import { loadSettings } from "./settings.ts";
import type { ParsedArgs } from "./startup.ts";
import { runStartup } from "./startup.ts";

// ============================================================================
// Non-interactive runner — `cast run "message"`
// ============================================================================

export interface RunOptions {
	message: string;
	format: "default" | "json";
}

/**
 * Run a single prompt non-interactively: startup → send → stream to stdout →
 * save session → exit. Reuses runStartup for model/persona/session resolution
 * and runAgentLoop for the actual LLM call + tool execution.
 */
export async function runNonInteractive(args: ParsedArgs, options: RunOptions): Promise<void> {
	const result = await runStartup(args, noPickers);
	const {
		config,
		session,
		systemPrompt,
		runner,
		mcpResult,
		confirmBash,
		permissionMode,
		personas,
		persona,
		subagentPrompts,
		subagentModel,
	} = result;

	appendMessage(session, { role: "user", content: options.message });

	const settings = loadSettings();
	const disabledTools = new Set<string>();
	if (settings.webTools !== true) {
		disabledTools.add("web_search");
		disabledTools.add("web_fetch");
	}

	const ac = new AbortController();
	runner.startRun(ac);

	const onSigint = () => runner.abort();
	process.on("SIGINT", onSigint);

	try {
		const finalMessages = await runAgentLoop(session.messages, {
			config,
			model: session.model,
			cwd: result.cwd,
			systemPrompt,
			signal: ac.signal,
			confirmBash: permissionMode === "bypass" ? undefined : confirmBash,
			mcpTools: mcpResult.toolDefinitions,
			mcpToolIndex: mcpResult.toolIndex,
			lastPromptTokens: session.lastPromptTokens,
			personas,
			currentPersona: persona.name,
			subagentPrompts,
			subagentModel,
			disabledTools,
			onEvent: (event: AgentEvent) => handleEvent(event, session, options.format),
		});

		session.messages = finalMessages;
	} finally {
		runner.endRun();
		saveSession(session);
		process.off("SIGINT", onSigint);
		await closeMcpConnections(mcpResult.connections);
	}

	process.exit(0);
}

function handleEvent(event: AgentEvent, session: SessionState, format: "default" | "json"): void {
	const emit = (type: string, data: Record<string, unknown>): boolean => {
		if (format === "json") {
			process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID: session.id, ...data }) + EOL);
			return true;
		}
		return false;
	};

	switch (event.type) {
		case "token":
			if (!emit("token", { text: event.text })) {
				process.stdout.write(event.text);
			}
			break;

		case "thinking":
			emit("thinking", { text: event.text });
			break;

		case "assistant_message":
			if (!emit("assistant_message", { content: event.content, toolCalls: event.toolCalls })) {
				if (event.content) process.stdout.write(EOL);
			}
			break;

		case "tool_start":
			if (!emit("tool_start", { id: event.id, name: event.name, args: event.args })) {
				process.stderr.write(`  ${event.name}...${EOL}`);
			}
			break;

		case "tool_end":
			if (!emit("tool_end", { id: event.id, name: event.name, result: event.result })) {
				if (event.result.isError) {
					process.stderr.write(`  ${event.name} failed: ${event.result.content}${EOL}`);
				}
			}
			break;

		case "doom_loop":
			if (!emit("doom_loop", { tool: event.tool, attempts: event.attempts })) {
				process.stderr.write(`  doom loop: ${event.tool} blocked after ${event.attempts} identical calls${EOL}`);
			}
			break;

		case "usage":
			addUsage(session, event.usage, { subagent: event.subagent });
			emit("usage", { usage: event.usage, subagent: event.subagent });
			break;

		case "end":
			if (!emit("end", { reason: event.reason })) {
				if (event.reason === "error") process.exitCode = 1;
			}
			break;

		case "error":
			if (!emit("error", { message: event.message })) {
				process.stderr.write(`Error: ${event.message}${EOL}`);
				process.exitCode = 1;
			}
			break;

		default:
			break;
	}
}
