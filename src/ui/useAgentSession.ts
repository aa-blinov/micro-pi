import { useCallback, useEffect, useRef, useState } from "react";
import type { AppConfig } from "../core/config.ts";
import { isRetryableStreamError } from "../core/llm.ts";
import { type AgentEvent, runAgentLoop } from "../core/loop.ts";
import type { McpSetupResult } from "../core/mcp.ts";
import type { AgentRunner } from "../core/runner.ts";
import { addUsage, appendMessage, type SessionState, type SessionUsage, saveSession } from "../core/session.ts";
import type { PermissionMode } from "../core/settings.ts";

export type AgentStatus = "idle" | "running" | "error";

export interface ToolCallEntry {
	id: string;
	name: string;
	args: string;
	status: "running" | "ok" | "error";
	result?: string;
}

export interface ChatMessage {
	role: "user" | "assistant" | "system" | "tool" | "warning";
	content: string;
	toolCalls?: ToolCallEntry[];
	/**
	 * Assistant reasoning captured while the turn streamed. Kept on the message
	 * so it stays visible in history instead of vanishing when the turn ends —
	 * it's only in the live streaming state otherwise. Not persisted to
	 * session.messages, so a rebuild/resume won't restore it.
	 */
	thinking?: string;
}

export interface PendingImage {
	id: string;
	dataUrl: string;
}

export interface StreamingState {
	content: string;
	thinking: string;
	toolCalls: ToolCallEntry[];
}

export interface RetryInfo {
	attempt: number;
	maxAttempts: number;
	reason: string;
}

export interface UseAgentSession {
	messages: ChatMessage[];
	streaming: StreamingState | null;
	status: AgentStatus;
	error: string | null;
	retry: RetryInfo | null;
	/** Cumulative totals across every turn in the session, not just the last one. */
	usage: SessionUsage | null;
	/** Usage for the most recently completed turn (cleared at the start of each new turn). */
	lastTurnUsage: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
		cost?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		uncachedTokens?: number;
		/** Output tokens/sec for this turn — undefined if nothing ever streamed. */
		tokensPerSecond?: number;
	} | null;
	/** Non-fatal warnings (e.g. vision fallback) — persist until next submit. */
	warnings: string[];
	/**
	 * Steer/follow-up messages queued but not yet injected into the running
	 * turn — stays populated for as long as the message is actually pending
	 * (until the loop drains it, or /abort clears it), not on a timer. A
	 * message can sit here for a while: the loop only re-checks its queues at
	 * a turn boundary, which for a long tool-heavy turn can be much later than
	 * a fixed toast timeout would show it for.
	 */
	pendingSteers: string[];
	pendingQueue: string[];
	submit: (text: string, images?: PendingImage[]) => Promise<void>;
	steer: (text: string) => void;
	followUp: (text: string) => void;
	abort: () => void;
	clearContext: () => void;
	refresh: () => void;
	resetQueue: () => void;
}

interface UseAgentSessionParams {
	session: SessionState;
	config: AppConfig;
	cwd: string;
	systemPrompt: string;
	runner: AgentRunner;
	permissionMode: PermissionMode;
	mcpResult: McpSetupResult;
	confirmBash: (command: string, reason: string) => Promise<boolean>;
}

/**
 * Flatten a raw message's content down to display text.
 *
 * Content starts as a plain string, but applyCacheControl (core/llm.ts)
 * rewrites it *in place* to a structured `[{ type: "text", text }, ...]` array
 * to attach cache markers — and those mutations land on the very objects held
 * in session.messages (and get persisted). Image attachments are structured
 * from the start too. Pull the text parts back out instead of collapsing the
 * whole thing to a "[structured content]" placeholder: otherwise a resumed
 * session — or a <Static> repaint after a terminal resize — renders the user's
 * own prompt (and the assistant's replies) as that placeholder.
 */
function messageContentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		let images = 0;
		for (const part of content) {
			if (!part || typeof part !== "object" || !("type" in part)) continue;
			const type = (part as { type: unknown }).type;
			if (type === "text" && typeof (part as { text?: unknown }).text === "string") {
				parts.push((part as { text: string }).text);
			} else if (type === "image_url") {
				images++;
			}
		}
		if (images > 0) parts.push(images === 1 ? "[image]" : `[${images} images]`);
		if (parts.length > 0) return parts.join("\n");
	}
	return "[structured content]";
}

/**
 * Rebuilds a flat display list from the raw OpenAI-shaped messages array.
 * An assistant turn with tool_calls plus the following role:tool results
 * collapses into one ChatMessage with a `toolCalls` array — the raw shape
 * (assistant message, then separate tool messages) leaks provider protocol
 * details into the transcript that the user shouldn't have to read.
 */
function buildDisplayMessages(sessionMessages: SessionState["messages"]): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (let i = 0; i < sessionMessages.length; i++) {
		const m = sessionMessages[i]!;
		if (m.role === "system") continue;
		if (m.role === "tool") continue;

		if (m.role === "user") {
			out.push({ role: "user", content: messageContentToText(m.content) });
			continue;
		}

		if (m.role === "assistant") {
			// Assistant turns are often tool-calls-only with null content — keep
			// those blank; only structured arrays carry extractable text.
			const content = Array.isArray(m.content) ? messageContentToText(m.content) : (m.content ?? "");
			const toolCalls: ToolCallEntry[] = [];
			if ("tool_calls" in m && m.tool_calls) {
				for (const tc of m.tool_calls) {
					if (tc.type !== "function") continue;
					toolCalls.push({
						id: tc.id,
						name: tc.function.name,
						args: tc.function.arguments,
						status: "ok",
					});
				}
			}
			// Associate following tool result messages with this assistant turn
			let next = i + 1;
			while (next < sessionMessages.length && sessionMessages[next]!.role === "tool") {
				const tr = sessionMessages[next] as { role: "tool"; content: string; tool_call_id?: string };
				const target = toolCalls.find((t) => t.id === tr.tool_call_id);
				if (target) target.result = String(tr.content).slice(0, 4000);
				next++;
			}
			// Advance i past the tool results so the for loop doesn't visit them again
			i = next - 1;
			out.push({ role: "assistant", content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined });
		}
	}
	return out;
}

export function useAgentSession(params: UseAgentSessionParams): UseAgentSession {
	const { session, config, cwd, systemPrompt, runner, permissionMode, mcpResult, confirmBash } = params;
	const [messages, setMessages] = useState<ChatMessage[]>(() => buildDisplayMessages(session.messages));
	const [streaming, setStreaming] = useState<StreamingState | null>(null);
	const [status, setStatus] = useState<AgentStatus>("idle");
	const [error, setError] = useState<string | null>(null);
	const [retry, setRetry] = useState<RetryInfo | null>(null);
	const [usage, setUsage] = useState<UseAgentSession["usage"]>(() => ({ ...session.usage }));
	const [lastTurnUsage, setLastTurnUsage] = useState<UseAgentSession["lastTurnUsage"]>(null);
	// Warnings shown in the chat history (e.g. "vision not supported").
	// Persist until the next submit, always appear before the agent's response.
	const [warnings, setWarnings] = useState<string[]>([]);
	// Mirrors runner.steeringQueue/followUpQueue's actual contents so the UI
	// can show what's pending — the queues themselves are plain mutable
	// classes with no reactivity of their own.
	const [pendingSteers, setPendingSteers] = useState<string[]>([]);
	const [pendingQueue, setPendingQueue] = useState<string[]>([]);

	const acRef = useRef<AbortController | null>(null);
	// The authoritative "current streaming" value — read and written directly,
	// never through setStreaming's own updater callback. React only guarantees
	// a setState updater function runs by the time of the *next render*, not
	// synchronously at the moment setState is called; it can defer and batch
	// queued updates. Two turn-boundary calls can happen back-to-back with no
	// render in between (turn_end immediately followed by the submit()
	// finally block's safety-net flush) — relying on the updater's own `prev`
	// argument there both read the *pre-update* value, so the second call
	// re-pushed the same completed turn (the actual cause of a duplicate-
	// message bug this once regressed to). streamingRef sidesteps that by
	// never depending on when React gets around to processing the queue.
	const streamingRef = useRef<StreamingState | null>(null);
	const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Flush pending streaming state to React immediately.
	const flushStreaming = useCallback(() => {
		if (flushTimerRef.current !== null) {
			clearTimeout(flushTimerRef.current);
			flushTimerRef.current = null;
		}
		setStreaming(streamingRef.current);
	}, []);

	// Accumulate streaming updates in the ref and schedule a deferred flush.
	// Rapid per-token events (thinking, token) batch into one React render
	// per ~16 ms frame instead of one per token. Structural changes (tool_start,
	// turn_end, etc.) call flushStreaming() directly for immediate UI feedback.
	const updateStreaming = useCallback(
		(updater: (prev: StreamingState | null) => StreamingState | null, immediate?: boolean) => {
			const next = updater(streamingRef.current);
			streamingRef.current = next;
			if (immediate) {
				flushStreaming();
			} else if (flushTimerRef.current === null) {
				flushTimerRef.current = setTimeout(() => {
					flushTimerRef.current = null;
					setStreaming(streamingRef.current);
				}, 16);
			}
		},
		[flushStreaming],
	);

	/**
	 * Appends the just-finished turn's streamed content (if any) as permanent
	 * history and resets streaming for the next turn. Promoting from the
	 * streaming state — not rebuilding from raw session/wire messages — is
	 * what keeps each tool call's real final status: a role:"tool" message in
	 * the OpenAI wire format carries no isError flag, so a rebuild could only
	 * ever guess "ok". This also respects Ink's <Static>, which permanently
	 * commits whatever an index held the first time it renders and never
	 * revisits it — pushing a tool call before it's done would freeze it at
	 * "running" forever, so this only runs at true turn boundaries.
	 */
	const promoteStreamingToHistory = useCallback(() => {
		const s = streamingRef.current;
		if (s && (s.content || s.thinking || s.toolCalls.length > 0)) {
			setMessages((msgs) => [
				...msgs,
				{
					role: "assistant",
					content: s.content,
					toolCalls: s.toolCalls.length > 0 ? s.toolCalls : undefined,
					thinking: s.thinking || undefined,
				},
			]);
		}
		updateStreaming(() => ({ content: "", thinking: "", toolCalls: [] }), true);
	}, [updateStreaming]);

	const refresh = useCallback(() => {
		const msgs = buildDisplayMessages(session.messages);
		// Insert warnings before the last assistant message so they appear
		// chronologically: user → warning → agent response.
		if (warnings.length > 0) {
			let lastAssistant = -1;
			for (let i = msgs.length - 1; i >= 0; i--) {
				if (msgs[i]!.role === "assistant") {
					lastAssistant = i;
					break;
				}
			}
			const insertAt = lastAssistant >= 0 ? lastAssistant : msgs.length;
			for (let i = warnings.length - 1; i >= 0; i--) {
				msgs.splice(insertAt, 0, { role: "warning", content: warnings[i]! });
			}
		}
		setMessages(msgs);
	}, [session, warnings]);

	const submit = useCallback(
		async (text: string, images?: PendingImage[]) => {
			if (runner.isRunning) {
				runner.steeringQueue.enqueue({ role: "user", content: text });
				return;
			}
			setError(null);
			setRetry(null);
			setLastTurnUsage(null);
			setWarnings([]);

			const userContent =
				images && images.length > 0
					? [
							{ type: "text" as const, text },
							...images.map((img) => ({
								type: "image_url" as const,
								image_url: { url: img.dataUrl },
							})),
						]
					: text;
			appendMessage(session, { role: "user", content: userContent });
			// Append directly rather than refresh()'s rebuild-from-session.messages —
			// an aborted or errored run doesn't merge its (possibly partial)
			// assistant turn back into session.messages (see the "aborted" case in
			// loop.ts's runLoop), so a rebuild right after one would produce a
			// *shorter* array than what promoteStreamingToHistory already
			// incrementally appended for that turn. Ink's <Static> never revisits
			// an index once rendered, so overwriting that slot with this new user
			// message here would just never be shown — the next thing appended
			// after it (the new turn's response) would still show up, landing at a
			// higher index, which is exactly the "my message vanished but the
			// reply appeared" bug this fixes.
			setMessages((msgs) => [...msgs, { role: "user", content: messageContentToText(userContent) }]);

			const ac = new AbortController();
			acRef.current = ac;
			runner.startRun(ac);

			const onSigint = () => {
				runner.abort();
			};
			process.on("SIGINT", onSigint);

			const onUncaught = (err: Error) => {
				if (!isRetryableStreamError(err)) {
					console.error(err);
					saveSession(session);
					process.exit(1);
				}
				saveSession(session);
				process.exit(1);
			};
			process.on("uncaughtException", onUncaught);

			setStatus("running");
			updateStreaming(() => ({ content: "", thinking: "", toolCalls: [] }), true);

			try {
				const result = await runAgentLoop(session.messages, {
					config,
					model: session.model,
					cwd,
					systemPrompt,
					signal: ac.signal,
					steeringQueue: runner.steeringQueue,
					followUpQueue: runner.followUpQueue,
					confirmBash: permissionMode === "bypass" ? undefined : confirmBash,
					mcpTools: mcpResult.toolDefinitions,
					mcpToolIndex: mcpResult.toolIndex,
					lastPromptTokens: session.lastPromptTokens,
					onWarning: (message: string) => setWarnings((w) => [...w, message]),
					onEvent: (event: AgentEvent) => {
						switch (event.type) {
							case "thinking":
								updateStreaming((s) => (s ? { ...s, thinking: s.thinking + event.text } : s));
								break;
							case "token":
								updateStreaming((s) => (s ? { ...s, content: s.content + event.text } : s));
								break;
							case "tool_start":
								updateStreaming(
									(s) =>
										s
											? {
													...s,
													toolCalls: [
														...s.toolCalls,
														{ id: event.id, name: event.name, args: event.args, status: "running" },
													],
												}
											: s,
									true,
								);
								break;
							case "tool_end":
								updateStreaming((s) => {
									if (!s) return s;
									return {
										...s,
										toolCalls: s.toolCalls.map((t) =>
											t.id === event.id
												? {
														...t,
														status: event.result.isError ? "error" : "ok",
														result: event.result.content.slice(0, 4000),
													}
												: t,
										),
									};
								}, true);
								break;
							case "steering_injected":
							case "followup_injected": {
								// Promote the turn-so-far first so history reads
								// chronologically (finished response, then the
								// injected message), then show the injected message
								// itself — otherwise a steering/follow-up message
								// typed mid-run never appears in the transcript.
								promoteStreamingToHistory();
								const injected: ChatMessage[] = event.messages.map((m) => ({
									role: "user",
									content: messageContentToText(m.content),
								}));
								setMessages((msgs) => [...msgs, ...injected]);
								setError(null);
								// MessageQueue.drain() hands back one message at a time, so
								// this only ever needs to drop the front entry — sliced by
								// length rather than hardcoding 1 in case that contract
								// ever changes.
								if (event.type === "steering_injected") {
									setPendingSteers((p) => p.slice(event.messages.length));
								} else {
									setPendingQueue((p) => p.slice(event.messages.length));
								}
								break;
							}
							case "turn_end":
								promoteStreamingToHistory();
								setError(null);
								break;
							case "compaction":
								refresh();
								break;
							case "compaction_failed":
								break;
							case "retry":
								setRetry({ attempt: event.attempt, maxAttempts: event.maxAttempts, reason: event.reason });
								break;
							case "usage": {
								addUsage(session, event.usage);
								setUsage({ ...session.usage });
								const tokensPerSecond =
									event.generationMs && event.generationMs > 0 && event.usage.completionTokens > 0
										? event.usage.completionTokens / (event.generationMs / 1000)
										: undefined;
								setLastTurnUsage({
									promptTokens: event.usage.promptTokens,
									completionTokens: event.usage.completionTokens,
									totalTokens: event.usage.totalTokens,
									cost: event.usage.cost,
									cacheReadTokens: event.usage.cacheReadTokens,
									cacheWriteTokens: event.usage.cacheWriteTokens,
									tokensPerSecond,
								});
								break;
							}
							case "end":
								if (event.reason === "aborted") {
									setError("Aborted");
								} else if (event.reason !== "stop" && event.reason !== "error") {
									// "error" reason's own detailed message was already set by
									// the "error" event that fires right before this one —
									// setting it again here would clobber that with just the
									// bare word "error". Anything else (unexpected reason
									// string) still gets shown as a fallback.
									setError(event.reason);
								}
								break;
							case "error":
								setError(event.message);
								break;
						}
					},
				});
				session.messages = result;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				setError(msg);
				setStatus("error");
			} finally {
				// Flush any trailing streamed content that never got a turn_end (e.g.
				// an uncaught mid-stream error) so it isn't silently lost, then force
				// streaming to null (not the blank object promoteStreamingToHistory
				// leaves behind) — ChatLog treats a non-null streaming object as
				// still running and would keep showing a spinner otherwise. No full
				// refresh() here: messages are already accurate from incremental
				// per-turn promotion, and rebuilding from raw session.messages would
				// lose each tool call's real status (see promoteStreamingToHistory).
				promoteStreamingToHistory();
				updateStreaming(() => null, true);
				setRetry(null);
				setStatus("idle");
				process.off("SIGINT", onSigint);
				process.off("uncaughtException", onUncaught);
				runner.endRun();
				acRef.current = null;
				saveSession(session);
			}
		},
		[
			runner,
			session,
			config,
			cwd,
			systemPrompt,
			permissionMode,
			mcpResult,
			confirmBash,
			refresh,
			promoteStreamingToHistory,
			updateStreaming,
		],
	);

	const steer = useCallback(
		(text: string) => {
			runner.steeringQueue.enqueue({ role: "user", content: text });
			setPendingSteers((p) => [...p, text]);
		},
		[runner],
	);

	const followUp = useCallback(
		(text: string) => {
			runner.followUpQueue.enqueue({ role: "user", content: text });
			setPendingQueue((p) => [...p, text]);
		},
		[runner],
	);

	const abort = useCallback(() => {
		runner.abort();
		// runner.abort() clears both queues (anything queued for this run is
		// moot once it's cancelled) — mirror that here so the UI doesn't keep
		// showing pending steer/follow-up entries that were just wiped.
		setPendingSteers([]);
		setPendingQueue([]);
	}, [runner]);

	const clearContext = useCallback(() => {
		session.messages = [];
		saveSession(session);
		// Static-rendered history is permanently committed to the terminal's own
		// scrollback (see ChatLog.tsx) — resetting the messages array doesn't
		// erase what's already printed. Clear screen + scrollback so /clear
		// actually looks cleared instead of just starting a fresh transcript
		// underneath the old one.
		process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
		refresh();
	}, [session, refresh]);

	const resetQueue = useCallback(() => {
		runner.followUpQueue.clear();
		runner.steeringQueue.clear();
		setPendingQueue([]);
		setPendingSteers([]);
	}, [runner]);

	useEffect(() => {
		refresh();
	}, [refresh]);

	// Flush pending streaming updates on unmount so the final frame is accurate.
	useEffect(() => {
		return () => {
			if (flushTimerRef.current !== null) {
				clearTimeout(flushTimerRef.current);
				flushTimerRef.current = null;
			}
		};
	}, []);

	return {
		messages,
		streaming,
		status,
		error,
		retry,
		usage,
		lastTurnUsage,
		warnings,
		pendingSteers,
		pendingQueue,
		submit,
		steer,
		followUp,
		abort,
		clearContext,
		refresh,
		resetQueue,
	};
}
