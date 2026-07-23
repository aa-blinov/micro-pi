/**
 * The `task` tool — delegates an assignment to a worker subagent running its
 * own agent loop. Concurrency is bounded by a semaphore, and bash confirmations
 * from parallel subagents are serialized so they don't race the shared
 * terminal. runAgentLoop is injected to avoid a circular import with loop.ts.
 */

import type { AppConfig } from "../config.ts";
import { formatContextFilesForPrompt, loadProjectContextFiles } from "../context-files.ts";
import { EMPTY_ASSISTANT_PLACEHOLDER, type Message, type Tool, type Usage } from "../llm.ts";
import type { LoopConfig } from "../loop.ts";
import type { McpToolHandle } from "../mcp.ts";
import { PLAN_TOOL_NAMES } from "../plan.ts";
import { formatSystemEnvironmentBlock, resolvePromptContextForCwd } from "../project.ts";
import type { SshHost } from "../ssh.ts";
import type { SubagentPrompt } from "../subagents.ts";
import type { ConfirmBash, ToolResult } from "./shared.ts";

/**
 * Walk assistants from the end and return the first non-empty string content,
 * skipping the loop's empty-content placeholder. Tools-only / blank final
 * turns must not erase an earlier real report.
 */
export function extractTaskResult(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "assistant") continue;
		if (typeof m.content !== "string") continue;
		const text = m.content.trim();
		if (!text || text === EMPTY_ASSISTANT_PLACEHOLDER) continue;
		return text;
	}
	return "";
}

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
	/** Provider credentials for the subagent model (if on a different provider). */
	subagentModelProvider?: { baseURL: string; apiKey: string };
	/** Tool names to exclude from the definitions sent to the model. */
	disabledTools?: Set<string>;
	/** Parent's plan state — lets build-mode subagents inherit the approved
	 * plan (mirror block) and plan-mode subagents inherit the bash block. */
	planState?: import("../plan.ts").PlanState;
	/**
	 * Whether the project cwd is trusted — gates the cwd AGENTS.md file when
	 * the subagent has `agentsMd: true` (the default).
	 */
	projectTrusted?: boolean;
	/** Parent `--no-skills` — skip auto skill discovery for the child too. */
	noSkills?: boolean;
	/** Parent `--skill` paths — still loaded when `noSkills` is set. */
	cliSkillPaths?: string[];
	/** Parent's MCP catalog block (`formatMcpForPrompt`) — tools are already
	 * inherited via mcpTools; this lists enabled servers in the prompt. */
	mcpPromptSuffix?: string;
	/** Parent SSH hosts so the child can use the `ssh` tool when configured. */
	sshHosts?: SshHost[];
	/** Injected to avoid circular dependency with loop.ts. */
	runAgentLoop: (messages: Message[], config: LoopConfig) => Promise<Message[]>;
}

/**
 * Assemble the child system prompt: role + AGENTS (optional) + rules/skills +
 * MCP catalog + Current System State (cwd/date/platform). Mirrors the parent
 * grounding surface so relative paths in assignments resolve correctly.
 */
export function buildTaskSystemPrompt(
	rolePrompt: string,
	cwd: string,
	config: AppConfig,
	opts: {
		agentsMd: boolean;
		projectTrusted: boolean;
		model: string;
		subagentName: string;
		subagentLabel: string;
		mcpPromptSuffix?: string;
		noSkills?: boolean;
		cliSkillPaths?: string[];
	},
): string {
	const agentsSuffix = opts.agentsMd
		? formatContextFilesForPrompt(loadProjectContextFiles(cwd, opts.projectTrusted))
		: "";
	const { rulesSuffix, rulesLazySuffix, skillsPromptSuffix } = resolvePromptContextForCwd(cwd, opts.projectTrusted, {
		noSkills: opts.noSkills,
		cliSkillPaths: opts.cliSkillPaths,
	});
	const stateBlock = formatSystemEnvironmentBlock(cwd, {
		model: opts.model,
		reasoningLevel: config.reasoningLevel,
		subagent: { name: opts.subagentName, label: opts.subagentLabel },
	});
	return [
		rolePrompt,
		agentsSuffix,
		rulesSuffix,
		rulesLazySuffix,
		skillsPromptSuffix,
		opts.mcpPromptSuffix ?? "",
		stateBlock,
	]
		.filter(Boolean)
		.join("");
}

export async function execTask(
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

	// Assignment stays in the user message only. System prompt = role + the
	// same project grounding the parent gets (AGENTS, rules, skills, MCP
	// catalog, cwd/date/platform) so relative paths aren't ambiguous.
	const rolePrompt = subagent?.systemPrompt ?? "You are a worker agent. Complete the assigned task.";
	const childSystemPrompt = buildTaskSystemPrompt(rolePrompt, cwd, config, {
		agentsMd: subagent?.agentsMd !== false,
		projectTrusted: deps.projectTrusted === true,
		model: deps.model,
		subagentName: subagent?.name ?? "worker",
		subagentLabel: subagent?.label ?? "Worker",
		mcpPromptSuffix: deps.mcpPromptSuffix,
		noSkills: deps.noSkills,
		cliSkillPaths: deps.cliSkillPaths,
	});

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
			modelProvider: deps.subagentModelProvider,
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
			// Subagents inherit the parent's restrictions (write/edit stay blocked
			// in plan mode) but never get the plan tools themselves — they explore
			// and report back; the parent owns the plan file.
			disabledTools: new Set([...(deps.disabledTools ?? []), ...PLAN_TOOL_NAMES]),
			// Frontmatter `tools:` on the subagent — undefined means all (minus
			// disabledTools above); when set, only listed names are advertised
			// and executable.
			allowedTools: subagent?.tools,
			projectTrusted: deps.projectTrusted,
			// Handoff, not authority: the child sees the plan (mirror block in
			// build mode, or the current draft during planning) but always runs
			// with enabled=false — the plan-mode restriction block references
			// authoring tools the child doesn't have. The parent's inspection-only
			// bash gate is inherited explicitly instead: explorers can run git
			// log/grep pipelines but still can't write.
			planState: deps.planState ? { ...deps.planState, enabled: false } : undefined,
			readOnlyBash: deps.planState?.enabled === true,
			sshHosts: deps.sshHosts,
			// ponytail: no personas/currentPersona/subagentModel — child can't delegate further
		});
	} finally {
		subagentSemaphore.release();
	}

	const text = extractTaskResult(finalMessages);

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
