import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "./config.ts";
import type { Message, Tool, Usage } from "./llm.ts";
import { applyCacheControl, createClient, isContextOverflow, streamAndCollect } from "./llm.ts";
import type { McpToolHandle } from "./mcp.ts";
import { compactMessages, estimateTokens, shouldCompact } from "./session.ts";
import { type ConfirmBash, createToolExecutor, getToolDefinitions, type ToolResult } from "./tools.ts";

// Prompts for the LLM call that summarizes old messages during compaction —
// content, not code, so they live in prompts/ alongside the persona files
// instead of as inline strings here. Two variants (matching pi): a fresh
// summary when this is the first compaction this session has hit, or an
// update-in-place instruction set when compactMessages found a previous
// summary to fold new messages into.
//
// The bundle (dist/index.js) sits one level below the install root where
// prompts/ lives; source files (src/core/*.ts) sit two levels below the
// repo root. Try the bundle path first, fall back to the dev path.
const _selfDir = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = existsSync(join(_selfDir, "..", "prompts"))
	? join(_selfDir, "..", "prompts")
	: join(_selfDir, "..", "..", "prompts");
const COMPACTION_SYSTEM_PROMPT = readFileSync(join(PROMPTS_DIR, "compaction-system.md"), "utf-8").trim();
const COMPACTION_PROMPT = readFileSync(join(PROMPTS_DIR, "compaction.md"), "utf-8").trim();
const COMPACTION_UPDATE_PROMPT = readFileSync(join(PROMPTS_DIR, "compaction-update.md"), "utf-8").trim();

// ============================================================================
// Compaction
// ============================================================================

export interface CompactSessionResult {
	messages: Message[];
	compacted: boolean;
	messagesCompacted: number;
	tokensBefore: number;
	/** Set when summarization threw — messages are returned untouched rather than lossily pruned. */
	error?: string;
}

/**
 * Run one compaction pass over `messages`. Shared by the agent loop's
 * automatic shouldCompact check and the manual /compact command — both need
 * the exact same prompt assembly and previous-summary threading, so this is
 * the one place that owns it.
 */
export async function compactSessionMessages(
	messages: Message[],
	config: AppConfig,
	model: string,
	signal?: AbortSignal,
	onRetry?: (attempt: number, maxAttempts: number, reason: string) => void,
	onUsage?: (usage: Usage) => void,
): Promise<CompactSessionResult> {
	const client = createClient(config);
	try {
		const result = await compactMessages(
			messages,
			async (text, previousSummary) => {
				const promptText = previousSummary
					? `<conversation>\n${text}\n</conversation>\n\n<previous-summary>\n${previousSummary}\n</previous-summary>\n\n${COMPACTION_UPDATE_PROMPT}`
					: `<conversation>\n${text}\n</conversation>\n\n${COMPACTION_PROMPT}`;
				const resp = await streamAndCollect(
					client,
					model,
					[
						{ role: "system", content: COMPACTION_SYSTEM_PROMPT },
						{ role: "user", content: promptText },
					],
					[],
					2000,
					signal,
					undefined,
					undefined,
					{},
					onRetry,
				);
				// The summarization call itself is a real request against the
				// model — it costs real tokens/money and was previously just
				// discarded here, silently under-reporting session usage/cost
				// every time compaction ran (automatic or /compact).
				if (resp.usage) onUsage?.(resp.usage);
				return resp.content;
			},
			config,
		);
		// messagesCompacted === 0 means compactMessages found no safe cut point
		// yet (see session.ts's safeCutIndex) and left messages untouched.
		if (result.summary.messagesCompacted > 0) {
			return {
				messages: result.messages,
				compacted: true,
				messagesCompacted: result.summary.messagesCompacted,
				tokensBefore: result.summary.tokensBefore,
			};
		}
		return { messages, compacted: false, messagesCompacted: 0, tokensBefore: result.summary.tokensBefore };
	} catch (error) {
		// Summarization failed (network error, provider outage, etc). Falling
		// back to pruning here used to silently and irreversibly discard
		// old messages — the user had no way to tell a real summary from a
		// lossy prune. Leave messages untouched instead: the caller sees
		// compacted:false + error, so the transcript isn't lost, and the next
		// turn just retries compaction (shouldCompact stays true) rather than
		// losing history to a transient failure.
		return {
			messages,
			compacted: false,
			messagesCompacted: 0,
			tokensBefore: estimateTokens(messages),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

// ============================================================================
// Message queue — from pi's PendingMessageQueue
// ============================================================================

/** Drains one queued message at a time — each becomes its own turn. */
export class MessageQueue {
	private messages: Message[] = [];

	enqueue(message: Message): void {
		this.messages.push(message);
	}

	hasItems(): boolean {
		return this.messages.length > 0;
	}

	drain(): Message[] {
		const first = this.messages[0];
		if (!first) return [];
		this.messages = this.messages.slice(1);
		return [first];
	}

	clear(): void {
		this.messages = [];
	}

	get length(): number {
		return this.messages.length;
	}
}

// ============================================================================
// Events — aligned with pi's AgentEvent taxonomy
// ============================================================================

export type AgentEvent =
	| { type: "thinking"; text: string }
	| { type: "token"; text: string }
	| {
			type: "assistant_message";
			content: string;
			thinking: string;
			toolCalls?: Array<{ id: string; name: string; arguments: string }>;
	  }
	| { type: "tool_start"; id: string; name: string; args: string }
	| { type: "tool_end"; id: string; name: string; result: ToolResult }
	| { type: "turn_end"; toolResults: Array<{ id: string; name: string; result: ToolResult }> }
	// Carries the actual injected messages (not just a count) so the UI can show
	// them as permanent history entries immediately, the same way it does for
	// a normal submit — otherwise a steering/follow-up message typed mid-run
	// would never appear in the transcript at all.
	| { type: "steering_injected"; messages: Message[] }
	| { type: "followup_injected"; messages: Message[] }
	| { type: "compaction"; messagesCompacted: number; tokensBefore: number }
	| { type: "compaction_failed"; reason: string }
	| { type: "retry"; attempt: number; maxAttempts: number; reason: string }
	// generationMs is only set for the main completion's usage — compaction's
	// own summarization call reports usage too (for cumulative cost tracking)
	// but isn't a user-facing turn, so there's no "last request" TPS to show for it.
	| { type: "usage"; usage: Usage; generationMs?: number }
	| { type: "end"; reason: string }
	| { type: "error"; message: string };

// ============================================================================
// Loop config
// ============================================================================

export interface LoopConfig {
	config: AppConfig;
	model: string;
	cwd: string;
	systemPrompt: string;
	onEvent: (event: AgentEvent) => void;
	/** Non-fatal warning shown to the user (e.g. vision fallback). */
	onWarning?: (message: string) => void;
	signal?: AbortSignal;
	steeringQueue?: MessageQueue;
	followUpQueue?: MessageQueue;
	confirmBash?: ConfirmBash;
	/** Definitions for connected MCP servers' tools, appended to the 7 built-in ones. */
	mcpTools?: Tool[];
	/** Dispatch table for mcpTools — checked before falling back to the built-in executor. */
	mcpToolIndex?: Map<string, McpToolHandle>;
	/** promptTokens from the most recent API response — used by shouldCompact
	 * as the authoritative context size instead of character-based estimation. */
	lastPromptTokens?: number;
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Run the agent loop starting from initialMessages.
 * Returns ALL messages (initial + new).
 */
export async function runAgentLoop(initialMessages: Message[], loopConfig: LoopConfig): Promise<Message[]> {
	const messages = [...initialMessages];
	await runLoop(messages, loopConfig);
	return messages;
}

// ============================================================================
// Core loop — outer (follow-up) + inner (tool calls + steering)
// ============================================================================

async function runLoop(messages: Message[], loopConfig: LoopConfig): Promise<void> {
	const { config, model: initialModel, cwd, systemPrompt, onEvent, onWarning, signal, mcpToolIndex } = loopConfig;
	const tools = [...getToolDefinitions(), ...(loopConfig.mcpTools ?? [])];
	const builtinExecuteTool = createToolExecutor(cwd, config, loopConfig.confirmBash);
	const executeTool = mcpToolIndex
		? (name: string, args: Record<string, unknown>, toolSignal?: AbortSignal): Promise<ToolResult> => {
				const mcpTool = mcpToolIndex.get(name);
				return mcpTool ? mcpTool.call(args, toolSignal) : builtinExecuteTool(name, args, toolSignal);
			}
		: builtinExecuteTool;
	const client = createClient(config);
	const steeringQueue = loopConfig.steeringQueue ?? new MessageQueue();
	const followUpQueue = loopConfig.followUpQueue ?? new MessageQueue();

	const currentModel = initialModel;

	try {
		// Outer loop: continues when follow-up messages arrive after agent would stop
		let overflowCompacted = false;
		outer: while (true) {
			if (signal?.aborted) {
				onEvent({ type: "end", reason: "aborted" });
				break;
			}

			// Ensure system prompt
			if (messages.length === 0 || messages[0]?.role !== "system") {
				messages.unshift({ role: "system", content: systemPrompt });
			} else {
				messages[0] = { role: "system", content: systemPrompt };
			}

			// Compaction
			if (shouldCompact(messages, config, loopConfig.lastPromptTokens)) {
				const result = await compactSessionMessages(
					messages,
					config,
					currentModel,
					signal,
					(attempt, maxAttempts, reason) => onEvent({ type: "retry", attempt, maxAttempts, reason }),
					(usage) => onEvent({ type: "usage", usage }),
				);
				if (result.compacted) {
					messages.length = 0;
					messages.push(...result.messages);
					onEvent({
						type: "compaction",
						messagesCompacted: result.messagesCompacted,
						tokensBefore: result.tokensBefore,
					});
				} else if (result.error) {
					onEvent({ type: "compaction_failed", reason: result.error });
				}
			}

			// Check for steering messages at start
			let pendingMessages = steeringQueue.drain();

			// Inner loop: process tool calls and steering messages
			let hasMoreToolCalls = true;

			while (hasMoreToolCalls || pendingMessages.length > 0) {
				// Inject pending steering messages
				if (pendingMessages.length > 0) {
					for (const msg of pendingMessages) {
						messages.push(msg);
					}
					onEvent({ type: "steering_injected", messages: [...pendingMessages] });
					pendingMessages = [];
				}

				// Stream assistant response
				// Apply prompt caching markers in-place before each request.
				// Mutates messages/tools but session state is rebuilt each turn.
				applyCacheControl(messages, tools);

				// Vision fallback: if the model doesn't support images (404 from
				// OpenRouter or similar), strip any image_url messages we added
				// after tool results and retry. The tool result text already
				// contains "[Image: ...]" so the agent still knows an image was
				// there — it just can't see it.
				let completion: Awaited<ReturnType<typeof streamAndCollect>>;
				try {
					completion = await streamAndCollect(
						client,
						currentModel,
						messages,
						tools,
						config.maxResponseTokens,
						signal,
						(token) => onEvent({ type: "token", text: token }),
						(token) => onEvent({ type: "thinking", text: token }),
						config.reasoningParams.body,
						(attempt, maxAttempts, reason) => onEvent({ type: "retry", attempt, maxAttempts, reason }),
					);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					const isVisionError =
						/image|vision/i.test(msg) ||
						(err instanceof Error && "status" in err && (err as { status: number }).status === 404);
					const hasImages = messages.some(
						(m) =>
							m.role === "user" &&
							Array.isArray(m.content) &&
							m.content.some((p: { type?: string }) => p.type === "image_url"),
					);
					if (isVisionError && hasImages) {
						// Remove image_url user messages
						for (let i = messages.length - 1; i >= 0; i--) {
							const m = messages[i]!;
							if (
								m.role === "user" &&
								Array.isArray(m.content) &&
								m.content.some((p: { type?: string }) => p.type === "image_url")
							) {
								messages.splice(i, 1);
							}
						}
						onWarning?.("Model doesn't support images — sending file path only");
						completion = await streamAndCollect(
							client,
							currentModel,
							messages,
							tools,
							config.maxResponseTokens,
							signal,
							(token) => onEvent({ type: "token", text: token }),
							(token) => onEvent({ type: "thinking", text: token }),
							config.reasoningParams.body,
							(attempt, maxAttempts, reason) => onEvent({ type: "retry", attempt, maxAttempts, reason }),
						);
					} else if (isContextOverflow(err) && !overflowCompacted) {
						// Context overflow — compact and retry the turn instead of
						// surfacing a raw error. Matches opencode's auto-compaction
						// on ContextOverflowError. Only once per turn to prevent
						// infinite loops when even compacted context is too large.
						const result = await compactSessionMessages(
							messages,
							config,
							currentModel,
							signal,
							(attempt, maxAttempts, reason) => onEvent({ type: "retry", attempt, maxAttempts, reason }),
							(usage) => onEvent({ type: "usage", usage }),
						);
						if (result.compacted) {
							messages.length = 0;
							messages.push(...result.messages);
							onEvent({
								type: "compaction",
								messagesCompacted: result.messagesCompacted,
								tokensBefore: result.tokensBefore,
							});
							overflowCompacted = true;
							// Restart the outer loop — system prompt, compaction
							// check, and fresh streamAndCollect will all run again.
							continue outer;
						}
						// Compaction itself failed — surface the original error.
						onEvent({ type: "compaction_failed", reason: msg });
						throw err;
					} else {
						throw err;
					}
				}

				if (completion.usage) {
					onEvent({ type: "usage", usage: completion.usage, generationMs: completion.generationMs });
				}

				// Check for streaming errors (pi pattern: stopReason check)
				if (completion.finishReason === "error" || completion.finishReason === "aborted") {
					const assistantMsg: Message = { role: "assistant", content: completion.content || null };
					messages.push(assistantMsg);
					onEvent({ type: "turn_end", toolResults: [] });
					onEvent({ type: "end", reason: completion.finishReason });
					return;
				}

				// Build assistant message
				const assistantMsg: Message = {
					role: "assistant",
					content: completion.content || null,
					...(completion.toolCalls && completion.toolCalls.length > 0
						? {
								tool_calls: completion.toolCalls.map((tc) => ({
									id: tc.id,
									type: "function" as const,
									function: { name: tc.name, arguments: tc.arguments },
								})),
							}
						: {}),
				};
				messages.push(assistantMsg);

				onEvent({
					type: "assistant_message",
					content: completion.content,
					thinking: completion.thinking,
					toolCalls: completion.toolCalls,
				});

				// Check for tool calls
				const toolCalls = completion.toolCalls;
				const toolResults: Array<{ id: string; name: string; result: ToolResult }> = [];
				hasMoreToolCalls = false;

				if (toolCalls && toolCalls.length > 0) {
					const executedToolBatch = await executeToolCalls(toolCalls, executeTool, onEvent, signal);
					toolResults.push(...executedToolBatch);
					hasMoreToolCalls = true;

					// Track new tool result messages
					for (const r of executedToolBatch) {
						const toolMsg: Message = { role: "tool", tool_call_id: r.id, content: r.result.content };
						messages.push(toolMsg);

						// A `role: "tool"` message can't carry image content per the
						// OpenAI-compatible chat API, so a `read` on an image file
						// follows its tool result with a separate user message
						// containing the actual image (only works if the model
						// supports vision; otherwise the provider surfaces its own
						// error, which is the honest outcome here).
						if (r.result.imageDataUrl) {
							const imageMsg: Message = {
								role: "user",
								content: [{ type: "image_url", image_url: { url: r.result.imageDataUrl } }],
							};
							messages.push(imageMsg);
						}
					}
				}

				onEvent({ type: "turn_end", toolResults });

				// re-poll steering at end of inner iteration
				pendingMessages = steeringQueue.drain();
			}

			// Agent would stop here. Check follow-up queue (outer loop).
			const followUpMsgs = followUpQueue.drain();
			if (followUpMsgs.length > 0) {
				for (const msg of followUpMsgs) {
					messages.push(msg);
				}
				onEvent({ type: "followup_injected", messages: [...followUpMsgs] });
				overflowCompacted = false;
				continue;
			}

			// No more messages — done
			onEvent({ type: "end", reason: "stop" });
			break;
		}
	} catch (error) {
		// An abort mid-stream throws (APIUserAbortError, or a connection error
		// from the socket being torn down) rather than resolving with a clean
		// finishReason — signal.aborted is the only reliable way to tell "this
		// exception is a direct result of /abort" apart from a genuine failure.
		// Without this check every abort surfaced as reason "error" (with the
		// generic message this catch produces) instead of "aborted".
		if (signal?.aborted) {
			onEvent({ type: "end", reason: "aborted" });
			return;
		}
		const message = error instanceof Error ? error.message : String(error);
		onEvent({ type: "error", message });
		onEvent({ type: "end", reason: "error" });
	}
}

// ============================================================================
// Tool execution — parallel
// ============================================================================

interface ToolCallResult {
	id: string;
	name: string;
	result: ToolResult;
}

async function executeToolCalls(
	toolCalls: Array<{ id: string; name: string; arguments: string }>,
	executeTool: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>,
	onEvent: (event: AgentEvent) => void,
	signal: AbortSignal | undefined,
): Promise<ToolCallResult[]> {
	const prepared: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
	for (const tc of toolCalls) {
		let args: Record<string, unknown>;
		try {
			args = JSON.parse(tc.arguments);
		} catch {
			args = {};
		}
		prepared.push({ id: tc.id, name: tc.name, args });
	}

	for (const tc of prepared) {
		onEvent({ type: "tool_start", id: tc.id, name: tc.name, args: JSON.stringify(tc.args) });
	}

	const results = await Promise.all(
		prepared.map(async (tc): Promise<ToolCallResult> => {
			if (signal?.aborted) {
				return { id: tc.id, name: tc.name, result: { content: "Aborted", isError: true } };
			}

			let result: ToolResult;
			try {
				result = await executeTool(tc.name, tc.args, signal);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				result = { content: message, isError: true };
			}

			return { id: tc.id, name: tc.name, result };
		}),
	);

	for (const { id, name, result } of results) {
		onEvent({ type: "tool_end", id, name, result });
	}

	return results;
}
