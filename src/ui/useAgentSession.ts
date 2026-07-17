import { useCallback, useEffect, useRef, useState } from "react";
import type { AppConfig } from "../core/config.ts";
import { initialAnnouncedLocalDate } from "../core/date-rollover-reminder.ts";
import { describeTurnError, isRetryableStreamError, stripHermesToolCalls } from "../core/llm.ts";
import { type AgentEvent, runAgentLoop } from "../core/loop.ts";
import { formatMcpForPrompt, type McpSetupResult } from "../core/mcp.ts";
import { readActivePlan } from "../core/plan.ts";
import type { AgentRunner } from "../core/runner.ts";
import { addUsage, appendMessage, type SessionState, type SessionUsage, saveSession } from "../core/session.ts";
import type { PermissionMode } from "../core/settings.ts";
import { setStreamingActive } from "../core/stdin-manager.ts";
import { displayWidthCacheFlush } from "./display-width.ts";

export type AgentStatus = "idle" | "running" | "error";

export interface ToolCallEntry {
	id: string;
	name: string;
	args: string;
	status: "running" | "ok" | "error";
	result?: string;
}

/**
 * One ordered block within a single assistant completion. The model streams
 * reasoning, text, and tool calls in some order; a completion can even go
 * text → tool → more text. Keeping them as an ordered list — instead of three
 * fixed lanes (all reasoning, then all text, then all tools) — is what lets
 * the transcript render in the true emission order. Adjacent same-kind chunks
 * (token-by-token text, streamed reasoning) coalesce into one block; a tool
 * call breaks the run so whatever streams after it starts a fresh block.
 */
export type StreamBlock =
	| { kind: "thinking"; text: string }
	| { kind: "content"; text: string }
	| { kind: "tool"; call: ToolCallEntry };

export interface ChatMessage {
	role: "user" | "assistant" | "system" | "tool" | "warning";
	/** Plain text for user/warning/system/tool rows. Assistant rows use `blocks`. */
	content: string;
	/**
	 * Assistant turn rendered as ordered reasoning/text/tool blocks. Carries the
	 * turn's reasoning too, so it stays visible in history instead of vanishing
	 * when the turn ends. Reasoning is not persisted to session.messages, so a
	 * rebuild/resume reconstructs only content + tool blocks (no reasoning, and
	 * no finer interleaving than "text then tools" — the wire format doesn't
	 * record it).
	 */
	blocks?: StreamBlock[];
}

export interface PendingImage {
	id: string;
	dataUrl: string;
}

export interface StreamingState {
	blocks: StreamBlock[];
}

/** Append text to the trailing block if it's the same kind, else start a new one. */
function appendText(blocks: StreamBlock[], kind: "thinking" | "content", text: string): StreamBlock[] {
	const last = blocks[blocks.length - 1];
	if (last && last.kind === kind) {
		return [...blocks.slice(0, -1), { kind, text: last.text + text }];
	}
	return [...blocks, { kind, text }];
}

/**
 * How many leading blocks have settled — can't change again, so they're safe to
 * hand to Ink's <Static> (which freezes an item on first render). Streaming only
 * ever grows the trailing block, so any non-trailing text/reasoning block is
 * done; a tool block is done once it's no longer running. Draining these out of
 * the live region as they settle is what keeps that region from growing past the
 * terminal height — where Ink's log-update erase math breaks and frames stack.
 */
export function settledPrefixLength(blocks: StreamBlock[]): number {
	let n = 0;
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i]!;
		const isLast = i === blocks.length - 1;
		const settled = b.kind === "tool" ? b.call.status !== "running" : !isLast;
		if (!settled) break;
		n++;
	}
	return n;
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
	/** Append a display-only message (not persisted to session). */
	addDisplayMessage: (message: ChatMessage) => void;
	/** Live stopwatch: ms since the current turn started. Freezes on the
	 * final value when the turn ends, resets to 0 on next submit. */
	elapsedMs: number;
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
	/** Per-turn system prompt rebuild for sticky rules + @-mention. */
	rebuildSystemPrompt?: (context: { userText: string; contextFiles: string[] }) => string;
	/** Available personas for the task tool. */
	personas?: import("../core/personas.ts").Persona[];
	/** Current persona name. */
	currentPersona?: string;
	/** Subagent prompts for the task tool. */
	subagentPrompts?: import("../core/subagents.ts").SubagentPrompt[];
	/** Model override for subagents. */
	subagentModel?: string;
	/** Tool names to exclude from the definitions sent to the model. */
	disabledTools?: Set<string>;
	/** Whether the project cwd is trusted — for subagent AGENTS.md injection. */
	projectTrusted?: boolean;
	/** Configured SSH hosts for the ssh tool. */
	sshHosts?: import("../core/ssh.ts").SshHost[];
	/** Plan mode state — passed to the agent loop for system prompt injection and tool gating. */
	planState?: import("../core/plan.ts").PlanState;
	/** Fires when a mode-transition tool succeeds mid-run: plan_done ("done")
	 * or plan_enter ("enter"). The App shows the corresponding confirmation
	 * dialog once the run settles — never mid-run, so tool sets stay consistent. */
	onPlanSignal?: (kind: "done" | "enter") => void;
	/** Runs the loop on this model instead of session.model — the plan-mode
	 * model override. session.model stays untouched: it is the user's main
	 * model, this is a per-phase substitution. */
	modelOverride?: string;
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
export function messageContentToText(content: unknown): string {
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
export function buildDisplayMessages(sessionMessages: SessionState["messages"]): ChatMessage[] {
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
			// those blank; only structured arrays carry extractable text. The wire
			// format records no reasoning and no text/tool interleaving, so the
			// best a rebuild can reconstruct is one content block (if any) followed
			// by the tool blocks in order.
			const content = Array.isArray(m.content) ? messageContentToText(m.content) : (m.content ?? "");
			const blocks: StreamBlock[] = [];
			if (content) blocks.push({ kind: "content", text: content });
			const toolBlocks: Array<Extract<StreamBlock, { kind: "tool" }>> = [];
			if ("tool_calls" in m && m.tool_calls) {
				for (const tc of m.tool_calls) {
					if (tc.type !== "function") continue;
					const block: Extract<StreamBlock, { kind: "tool" }> = {
						kind: "tool",
						call: { id: tc.id, name: tc.function.name, args: tc.function.arguments, status: "ok" },
					};
					toolBlocks.push(block);
					blocks.push(block);
				}
			}
			// Associate following tool result messages with this assistant turn
			let next = i + 1;
			while (next < sessionMessages.length && sessionMessages[next]!.role === "tool") {
				const tr = sessionMessages[next] as { role: "tool"; content: string; tool_call_id?: string };
				const target = toolBlocks.find((t) => t.call.id === tr.tool_call_id);
				if (target) target.call.result = String(tr.content).slice(0, 4000);
				next++;
			}
			// Advance i past the tool results so the for loop doesn't visit them again
			i = next - 1;
			out.push({ role: "assistant", content: "", blocks: blocks.length > 0 ? blocks : undefined });
		}
	}
	return out;
}

export function useAgentSession(params: UseAgentSessionParams): UseAgentSession {
	const {
		session,
		config,
		cwd,
		systemPrompt,
		runner,
		permissionMode,
		mcpResult,
		confirmBash,
		rebuildSystemPrompt,
		personas,
		currentPersona,
		subagentPrompts,
		subagentModel,
		disabledTools,
		projectTrusted,
		planState,
		onPlanSignal,
		modelOverride,
	} = params;
	const [messages, setMessages] = useState<ChatMessage[]>(() => buildDisplayMessages(session.messages));
	const [streaming, setStreaming] = useState<StreamingState | null>(null);
	const [status, setStatus] = useState<AgentStatus>("idle");
	const [error, setError] = useState<string | null>(null);
	const [retry, setRetry] = useState<RetryInfo | null>(null);
	const [usage, setUsage] = useState<UseAgentSession["usage"]>(() => ({ ...session.usage }));
	const [lastTurnUsage, setLastTurnUsage] = useState<UseAgentSession["lastTurnUsage"]>(null);
	// Live stopwatch: ticks while the agent is running, freezes on the final
	// value when the turn ends, resets on the next submit.
	const [elapsedMs, setElapsedMs] = useState(0);
	const turnStartRef = useRef(0);
	// Mirrors runner.steeringQueue/followUpQueue's actual contents so the UI
	// can show what's pending — the queues themselves are plain mutable
	// classes with no reactivity of their own.
	const [pendingSteers, setPendingSteers] = useState<string[]>([]);
	const [pendingQueue, setPendingQueue] = useState<string[]>([]);

	const acRef = useRef<AbortController | null>(null);
	// Set when a retry event arrives; cleared on the first streaming event
	// (token/thinking) so the retry banner disappears once new content flows.
	const clearRetryOnNextChunk = useRef(false);
	// Doom-loop warnings queued until turn_end: the blocked tool's block is
	// still in the live streaming region when the doom_loop event fires, so
	// appending the warning to history immediately would print it ABOVE the
	// very tool call it refers to. turn_end promotes the streaming blocks
	// first, then these flush in the right order.
	const pendingDoomWarningsRef = useRef<string[]>([]);
	// Tool names by call id for the current run: tool_end events don't carry
	// the name, and the plan_done notice below needs to know which tool ended.
	const toolNamesByIdRef = useRef(new Map<string, string>());
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
	// Context files (paths from read/write/edit tool calls) accumulated across
	// this session's submits, so a glob rule that latched onto a file read in an
	// earlier message stays attached. Reset when the session itself changes
	// (/new, session switch) via the render-time "reset state on prop change"
	// pattern — an effect would lag one render and trip exhaustive-deps.
	const contextFilesRef = useRef<string[]>([]);
	const contextFilesSessionRef = useRef(session.id);
	if (contextFilesSessionRef.current !== session.id) {
		contextFilesSessionRef.current = session.id;
		contextFilesRef.current = [];
	}

	// Live stopwatch: start an interval when the agent starts running,
	// freeze on the final value when it stops, reset on next submit.
	useEffect(() => {
		if (status === "running") {
			turnStartRef.current = Date.now();
			const id = setInterval(() => setElapsedMs(Date.now() - turnStartRef.current), 200);
			return () => clearInterval(id);
		}
	}, [status]);

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
			let next = updater(streamingRef.current);
			// Drain settled blocks (finished reasoning/text/completed tool calls)
			// out of the live region into <Static> history the moment they can't
			// change again, leaving only the actively-streaming tail live. Without
			// this the whole turn accumulates in Ink's live region; once it grows
			// past the terminal height, log-update's erase can't reach the rows
			// that scrolled off and frames stack instead of overwriting (duplicated
			// [reasoning] lines, spinner-per-line). A settle is a structural
			// boundary, so flush the frame immediately when one happens rather than
			// leaving the drained blocks visible in the live region for up to 16ms.
			let settledNow = false;
			if (next && next.blocks.length > 0) {
				const settled = settledPrefixLength(next.blocks);
				if (settled > 0) {
					const promoted = next.blocks.slice(0, settled);
					next = { blocks: next.blocks.slice(settled) };
					setMessages((msgs) => [...msgs, { role: "assistant", content: "", blocks: promoted }]);
					settledNow = true;
				}
			}
			streamingRef.current = next;
			if (immediate || settledNow) {
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
	 * Flushes whatever's left in the live region (the trailing block that never
	 * settled while streaming) into permanent history and resets streaming for
	 * the next turn. Most blocks already left the live region as they settled
	 * (see updateStreaming's drain); this just commits the tail. Promoting from
	 * the streaming state — not rebuilding from raw session/wire messages — is
	 * what keeps each tool call's real final status: a role:"tool" message in
	 * the OpenAI wire format carries no isError flag, so a rebuild could only
	 * ever guess "ok". Respects Ink's <Static>, which permanently commits
	 * whatever an index held the first time it renders and never revisits it —
	 * safe here because a tool block only ever leaves streaming once it's no
	 * longer "running" (both here and in the incremental drain).
	 */
	const promoteStreamingToHistory = useCallback(() => {
		const s = streamingRef.current;
		if (s && s.blocks.length > 0) {
			setMessages((msgs) => [...msgs, { role: "assistant", content: "", blocks: s.blocks }]);
		}
		updateStreaming(() => ({ blocks: [] }), true);
	}, [updateStreaming]);

	// Rebuild-from-session must never run mid-turn: <Static> permanently
	// commits items by index and never revisits them, so replacing the
	// incrementally-promoted messages array with a (differently-sized) rebuild
	// desyncs the array from what's already printed. Deps are [session] only —
	// session's identity is stable for the App's lifetime, so the mount effect
	// below fires exactly once; every other call site (compaction, /clear,
	// session switch) invokes refresh() explicitly at a turn boundary.
	const refresh = useCallback(() => {
		setMessages(buildDisplayMessages(session.messages));
		setUsage({ ...session.usage });
		setLastTurnUsage(null);
	}, [session]);

	const submit = useCallback(
		async (text: string, images?: PendingImage[]) => {
			if (runner.isRunning) {
				runner.steeringQueue.enqueue({ role: "user", content: text });
				return;
			}
			setError(null);
			setRetry(null);
			setLastTurnUsage(null);
			setElapsedMs(0);

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
				saveSession(session);
				if (isRetryableStreamError(err)) {
					// Retryable stream errors (mid-flight connection drop, 429 rate
					// limit, 5xx) are transient — save the session and let the process
					// live so the finally block can clean up the run state gracefully.
					// Non-retryable errors (programming bugs, corrupted state) are fatal.
					return;
				}
				console.error(err);
				process.exit(1);
			};
			process.on("uncaughtException", onUncaught);

			setStatus("running");
			// A turn aborted before its turn_end would otherwise leak queued
			// doom-loop warnings into the next turn's flush.
			pendingDoomWarningsRef.current = [];
			toolNamesByIdRef.current.clear();
			updateStreaming(() => ({ blocks: [] }), true);
			setStreamingActive(true);

			try {
				if (!session.lastAnnouncedLocalDate) {
					session.lastAnnouncedLocalDate = initialAnnouncedLocalDate(session);
				}
				const announcedLocalDate = {
					get value() {
						return session.lastAnnouncedLocalDate!;
					},
					set value(next: string) {
						session.lastAnnouncedLocalDate = next;
					},
				};
				const result = await runAgentLoop(session.messages, {
					config,
					model: modelOverride ?? session.model,
					cwd,
					systemPrompt,
					signal: ac.signal,
					steeringQueue: runner.steeringQueue,
					followUpQueue: runner.followUpQueue,
					confirmBash: permissionMode === "bypass" ? undefined : confirmBash,
					mcpTools: mcpResult.toolDefinitions,
					mcpToolIndex: mcpResult.toolIndex,
					lastPromptTokens: session.lastPromptTokens,
					rebuildSystemPrompt,
					contextFiles: contextFilesRef.current,
					personas,
					currentPersona,
					subagentPrompts,
					subagentModel,
					disabledTools,
					projectTrusted,
					sshHosts: params.sshHosts,
					mcpPromptSuffix: formatMcpForPrompt(mcpResult),
					planState,
					announcedLocalDate,
					// Append straight into the display history: warnings fire mid-run
					// (e.g. vision fallback, before the response streams), so an
					// append lands chronologically right — after the user message and
					// any already-settled blocks, above the live streaming region.
					// The old warnings-state + rebuild-on-refresh approach inserted
					// them below <Static>'s already-rendered index, where they were
					// never printed at all.
					onWarning: (message: string) => setMessages((msgs) => [...msgs, { role: "warning", content: message }]),
					onEvent: (event: AgentEvent) => {
						switch (event.type) {
							case "thinking":
								if (clearRetryOnNextChunk.current) {
									clearRetryOnNextChunk.current = false;
									setRetry(null);
								}
								updateStreaming((s) => (s ? { blocks: appendText(s.blocks, "thinking", event.text) } : s));
								break;
							case "token": {
								if (clearRetryOnNextChunk.current) {
									clearRetryOnNextChunk.current = false;
									setRetry(null);
								}
								updateStreaming((s) => {
									if (!s) return s;
									const appended = appendText(s.blocks, "content", event.text);
									// Strip duplicate Hermes XML tool-call blocks as they accumulate.
									// Only strip if we see <tool_call> to avoid accidentally removing
									// user-provided XML that happens to contain <function=.
									const last = appended[appended.length - 1];
									if (last && last.kind === "content" && last.text.includes("<tool_call>")) {
										const stripped = stripHermesToolCalls(last.text);
										if (stripped !== last.text) {
											return {
												blocks: [...appended.slice(0, -1), { kind: "content" as const, text: stripped }],
											};
										}
									}
									return { blocks: appended };
								});
								break;
							}
							case "tool_start":
								toolNamesByIdRef.current.set(event.id, event.name);
								updateStreaming(
									(s) =>
										s
											? {
													blocks: [
														...s.blocks,
														{
															kind: "tool",
															call: {
																id: event.id,
																name: event.name,
																args: event.args,
																status: "running",
															},
														},
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
										blocks: s.blocks.map((b) =>
											b.kind === "tool" && b.call.id === event.id
												? {
														kind: "tool",
														call: {
															...b.call,
															status: event.result.isError ? "error" : "ok",
															result: event.result.content.slice(0, 4000),
														},
													}
												: b,
										),
									};
								}, true);
								// plan_done / plan_enter succeeding are mode-transition signals:
								// leave a persistent pointer in the transcript (a timed notice
								// would vanish while the user is still reading), and tell the
								// App so it can show the confirmation dialog once the run ends.
								if (!event.result.isError) {
									const endedTool = toolNamesByIdRef.current.get(event.id);
									if (endedTool === "plan_done") {
										// Full path in the transcript so the user can cmd-click it
										// open in their editor — the plan is theirs to review.
										const planPath = planState ? readActivePlan(planState).path : undefined;
										setMessages((msgs) => [
											...msgs,
											{
												role: "warning",
												content: `[Plan ready${planPath ? `: ${planPath}` : ""} — approval dialog opens when the turn ends]`,
											},
										]);
										onPlanSignal?.("done");
									} else if (endedTool === "plan_enter") {
										onPlanSignal?.("enter");
									}
								}
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
							case "turn_end": {
								promoteStreamingToHistory();
								setError(null);
								const doomWarnings = pendingDoomWarningsRef.current;
								if (doomWarnings.length > 0) {
									pendingDoomWarningsRef.current = [];
									setMessages((msgs) => [
										...msgs,
										...doomWarnings.map((content) => ({ role: "warning" as const, content })),
									]);
								}
								break;
							}
							case "compaction":
								refresh();
								break;
							case "compaction_failed":
								break;
							case "doom_loop":
								pendingDoomWarningsRef.current.push(
									`[doom loop] ${event.tool} blocked after ${event.attempts} identical calls`,
								);
								break;
							case "open_work_gate":
								pendingDoomWarningsRef.current.push(
									`[open work] continuing — ${event.openSteps} plan step(s) still open (nudge ${event.fires})`,
								);
								break;
							case "open_work_gate_exhausted":
								pendingDoomWarningsRef.current.push(
									`[open work] stopped after ${event.maxFires} nudge(s) — ${event.openSteps} plan step(s) still open`,
								);
								break;
							case "retry":
								setRetry({ attempt: event.attempt, maxAttempts: event.maxAttempts, reason: event.reason });
								clearRetryOnNextChunk.current = true;
								break;
							case "usage": {
								addUsage(session, event.usage, { subagent: event.subagent });
								setUsage({ ...session.usage });
								// A subagent's usage isn't a user-facing turn — don't let it
								// overwrite the main agent's last-turn / tok-s readout.
								if (event.subagent) break;
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
									setMessages((msgs) => [...msgs, { role: "warning", content: "[aborted]" }]);
								} else if (event.reason === "disconnected") {
									setMessages((msgs) => [...msgs, { role: "warning", content: "[terminated]" }]);
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
				setError(describeTurnError(err));
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
				setStreamingActive(false);
				displayWidthCacheFlush();
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
			rebuildSystemPrompt,
			personas,
			currentPersona,
			subagentPrompts,
			subagentModel,
			disabledTools,
			projectTrusted,
			planState,
			onPlanSignal,
			modelOverride,
			params.sshHosts,
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
		// The authoritative context-size signal must reset with the context it
		// measured — otherwise shouldCompact still sees the pre-clear size and
		// the first turn after clearing a long session (e.g. the "clear context,
		// then implement" plan approval) runs a pointless compaction pass over
		// an almost-empty conversation.
		session.lastPromptTokens = undefined;
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

	const addDisplayMessage = useCallback((message: ChatMessage) => {
		setMessages((msgs) => [...msgs, message]);
	}, []);

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
		pendingSteers,
		pendingQueue,
		submit,
		steer,
		followUp,
		abort,
		clearContext,
		refresh,
		resetQueue,
		addDisplayMessage,
		elapsedMs,
	};
}
