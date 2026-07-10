/**
 * The `task` tool — delegates an assignment to a worker subagent running its
 * own agent loop. Concurrency is bounded by a semaphore, and bash confirmations
 * from parallel subagents are serialized so they don't race the shared
 * terminal. runAgentLoop is injected to avoid a circular import with loop.ts.
 */

import type { AppConfig } from "../config.ts";
import type { Message, Tool, Usage } from "../llm.ts";
import type { LoopConfig } from "../loop.ts";
import type { McpToolHandle } from "../mcp.ts";
import type { SubagentPrompt } from "../subagents.ts";
import type { ConfirmBash, ToolResult } from "./shared.ts";

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
	/** Injected to avoid circular dependency with loop.ts. */
	runAgentLoop: (messages: Message[], config: LoopConfig) => Promise<Message[]>;
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
