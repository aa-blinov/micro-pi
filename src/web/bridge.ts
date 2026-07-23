/**
 * Web agent bridge — wraps core/loop.ts + core/runner.ts for web clients.
 * Each WebAgentSession has its own AgentRunner and runs runAgentLoop in the
 * background. SSE listeners receive AgentEvent broadcasts in real time.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchModels, type ModelInfo, probeProvider, resolveProvider } from "../core/config.ts";
import type { Message } from "../core/llm.ts";
import { type AgentEvent, compactSessionMessages, runAgentLoop } from "../core/loop.ts";
import { closeMcpConnections, formatMcpForPrompt } from "../core/mcp.ts";
import type { Persona } from "../core/personas.ts";
import { createPlanState, modeDisabledTools } from "../core/plan.ts";
import {
	addMarketplace,
	getMarketplaceCatalog,
	installPlugin,
	listInstalledPlugins,
	listKnownMarketplaces,
	removeMarketplace,
	setPluginEnabled,
	uninstallPlugin,
	updateMarketplace,
} from "../core/plugins.ts";

import {
	buildSystemPrompt,
	discoverSkillsForCwd,
	removeMcpServerFromDisk,
	resolveMcpForCwd,
	resolvePersonasForCwd,
	resolveProjectTrustForCwd,
	resolveRulesForCwd,
	resolveSkillsForCwd,
} from "../core/project.ts";
import { getModelsCache, setModelsCache } from "../core/readline.ts";

import { formatRuleInvocation } from "../core/rules.ts";
import { type AgentRunner, createAgentRunner } from "../core/runner.ts";
import {
	addUsage,
	appendMessage,
	createSession,
	listSessionSummaries,
	loadSession,
	resetSavedMessageCount,
	type SessionState,
	saveSession,
} from "../core/session.ts";
import { loadSettings, updateSettings } from "../core/settings.ts";
import { isUninstallableSkill, uninstallUserSkill } from "../core/skills.ts";
import { saveSshConfig } from "../core/ssh.ts";
import type { StartupResult } from "../core/startup.ts";
import { BackgroundTaskRegistry, type BashBackgroundDeps } from "../core/tools/bash-background.ts";
import { getReasoningOptions } from "../core/vendors.ts";
import { ALL_THEMES } from "../ui/themes/index.ts";
import type { ThemeColors } from "../ui/themes/types.ts";
import { isCommandBlocking, SLASH_COMMANDS } from "./commands.ts";

export type WebAgentStatus = "idle" | "running" | "error";

export type WebEvent =
	| AgentEvent
	| { type: "status"; status: WebAgentStatus }
	| { type: "session_update"; session: SessionSummary }
	| { type: "session_end"; usage: SessionState["usage"]; messageCount: number }
	| { type: "session_closed" };

export interface WebAgentSession {
	id: string;
	session: SessionState;
	runner: AgentRunner;
	backgroundBash: BashBackgroundDeps;
	status: WebAgentStatus;
	error: string | null;
	listeners: Set<(event: WebEvent) => void>;
	/** Rebuilt whenever persona or model changes — see `computeSystemPrompt`. */
	systemPrompt: string;
	/** Ephemeral, like the TUI's `lastTurnUsage` (useAgentSession.ts) — not
	 * persisted to disk, cleared implicitly by just being overwritten each
	 * turn. Surfaced via /current. */
	lastTurn?: { generationMs?: number; tokensPerSecond?: number; completedAt: string };
}

export interface SessionSummary {
	id: string;
	persona: string;
	model: string;
	cwd: string;
	title?: string;
	pinned?: boolean;
	status: WebAgentStatus;
	messageCount: number;
	createdAt: string;
	updatedAt: string;
}

export interface DisplayToolCall {
	id: string;
	name: string;
	args: string;
	status: "ok" | "error";
	result: string;
}

/** UI-friendly shape — matches what the client already builds live from SSE
 * events (see app.js's "assistant_message" handler), so a history reload
 * (GET /api/sessions/:id) renders identically to a freshly-streamed turn. */
export interface DisplayMessage {
	role: string;
	content: string | null;
	toolCalls?: DisplayToolCall[];
	thinking?: string;
}

/**
 * Session storage keeps the raw OpenAI wire format: assistant messages carry
 * `tool_calls` (snake_case, `{id, function:{name,arguments}}`) with their
 * results as separate trailing `{role:"tool", tool_call_id, content}`
 * messages, and a tool-only turn's `content` is the sentinel `null` (see
 * core/loop.ts) rather than an empty string. Sent as-is, the client would
 * stringify that `null` into the literal text "null" and have no `toolCalls`
 * array to render a card from. This folds each assistant message's tool
 * calls and their matching results together and drops the (i.e. already
 * merged-in) `tool` messages entirely. `reasoning` (SessionState's sidecar
 * map, index -> thinking text — see core/session.ts) reattaches each
 * assistant message's reasoning so a reload looks the same as a live turn.
 */
export function toDisplayMessages(messages: Message[], reasoning?: Record<number, string>): DisplayMessage[] {
	// Pre-index tool results by call_id — turns O(N*M) lookups into O(M).
	const toolResults = new Map<string, Message>();
	for (const m of messages) {
		if (m.role === "tool" && "tool_call_id" in m && m.tool_call_id) toolResults.set(m.tool_call_id, m);
	}
	const out: DisplayMessage[] = [];
	messages.forEach((m, i) => {
		if (m.role === "tool") return;
		if (m.role === "assistant" && "tool_calls" in m && m.tool_calls && m.tool_calls.length > 0) {
			const toolCalls: DisplayToolCall[] = m.tool_calls
				.filter((tc) => tc.type === "function")
				.map((tc) => {
					const resultMsg = toolResults.get(tc.id);
					return {
						id: tc.id,
						name: tc.function.name,
						args: tc.function.arguments,
						status: resultMsg && (resultMsg as { castIsError?: boolean }).castIsError ? "error" : "ok",
						result: resultMsg ? String(resultMsg.content ?? "") : "",
					};
				});
			out.push({
				role: "assistant",
				content: typeof m.content === "string" ? m.content : null,
				toolCalls,
				thinking: reasoning?.[i],
			});
			return;
		}
		out.push({
			role: m.role,
			content: typeof m.content === "string" ? m.content : null,
			thinking: m.role === "assistant" ? reasoning?.[i] : undefined,
		});
	});
	return out;
}

export interface WebBridge {
	createSession(personaName?: string, modelOverride?: string, cwdOverride?: string): WebAgentSession;
	getSession(id: string): WebAgentSession | undefined;
	listSessions(): SessionSummary[];
	/** Aborts any in-flight run and drops the session from the live list — it
	 * stays on disk (autosaved already), it just stops appearing as a running
	 * background agent. Returns false if the id doesn't exist. */
	closeSession(sessionId: string): boolean;
	/** Manual rename — overrides the auto-derived title permanently. Returns
	 * false if the id doesn't exist. Empty/whitespace-only clears back to
	 * showing the persona name. */
	renameSession(sessionId: string, title: string): boolean;
	/** Toggle pin-to-top in the session list. Returns false if the id doesn't exist. */
	pinSession(sessionId: string, pinned: boolean): boolean;
	submit(sessionId: string, text: string): void;
	abort(sessionId: string): void;
	subscribe(sessionId: string, callback: (event: WebEvent) => void): void;
	unsubscribe(sessionId: string, callback: (event: WebEvent) => void): void;
	executeCommand(sessionId: string, command: string): Promise<{ ok: boolean; result?: unknown; error?: string }>;
	getConfig(): { baseURL: string; model: string; persona: string; theme: string; cwd: string };
	getPersonas(): Array<{ name: string; label: string; description: string; source: string }>;
	getThemes(): Array<{ id: string; label: string; description: string; colors: ThemeColors }>;
	getModels(providerName?: string): Promise<{ models: ModelInfo[]; error?: string }>;
	getCachedModels(): { models: ModelInfo[] };
	saveSshKey(name: string, keyContent: string): { ok: boolean; path?: string; error?: string };
	getReasoningOptionsForSession(sessionId: string): { options: Array<{ value: string; label: string }> };
	suggestCommand(sessionId: string, input: string): Array<{ value: string; label: string }>;
}

export function createWebBridge(result: StartupResult): WebBridge {
	const sessions = new Map<string, WebAgentSession>();

	const { config, cwd, persona: currentPersona, reasoningMeta, projectDeps } = result;

	// Everything below is captured once at startup by the TUI's own
	// per-process App component, but the web bridge outlives many
	// sessions/requests — so /reload, /mcp, /skills, and /plugin (anything
	// that changes project-local resources) need these as *mutable* bridge
	// state, not `const`s from the initial destructure, plus a way to push a
	// change out to every live session's system prompt (see
	// recomputeAllSystemPrompts below), not just the one that issued the command.
	let mcpResult = result.mcpResult;
	let personas = result.personas;
	let subagentModel = result.subagentModel;
	let subagentModelProvider = result.subagentModelProvider;
	let planModel = result.planModel;
	let planModelProvider = result.planModelProvider;
	let projectTrusted = result.projectTrusted;
	const contextFilesSuffix = result.contextFilesSuffix;
	let rulesSuffix = result.rulesSuffix;
	let rulesLazySuffix = result.rulesLazySuffix;
	let directoryRules = result.directoryRules;
	let skillsPromptSuffix = result.skillsPromptSuffix;
	// SSH hosts and permission mode are simple settings-backed values with no
	// prompt-rebuild fan-out, but still need to be mutable so /ssh and
	// /permissions actually take effect without a server restart.
	let sshHosts = result.sshHosts;
	let permissionMode = result.permissionMode;
	const subPrompts = result.subagentPrompts;

	/**
	 * Same `buildSystemPrompt` core call the TUI's /persona and /model handlers
	 * use (src/ui/commands.ts `rebuildSystemPrompt`) — kept here as a direct
	 * call rather than a re-wrapped helper so this file doesn't grow its own
	 * copy of the assembly logic.
	 */
	function computeSystemPrompt(persona: Persona, model: string, sessionCwd: string, mode?: "plan" | "build"): string {
		return buildSystemPrompt(
			persona,
			contextFilesSuffix,
			rulesSuffix,
			rulesLazySuffix,
			skillsPromptSuffix,
			formatMcpForPrompt(mcpResult),
			sessionCwd,
			{ model, reasoningLevel: config.reasoningLevel, reasoningMeta, mode },
		);
	}

	function resolvePersona(name: string): Persona | undefined {
		return personas.find((p) => p.name === name);
	}

	/** Rebuilds every live session's system prompt from current bridge-level
	 * project state — needed after /reload, /mcp, or /skills, since those
	 * change resources shared by every session, not just the one that issued
	 * the command (unlike /model or /persona, which are already per-session). */
	function recomputeAllSystemPrompts(): void {
		for (const ws of sessions.values()) {
			const persona = resolvePersona(ws.session.persona ?? "") ?? currentPersona;
			ws.systemPrompt = computeSystemPrompt(persona, ws.session.model, ws.session.cwd ?? cwd, ws.session.mode);
		}
	}

	// `submit` (a hoisted function declared further down this closure) is only
	// ever *invoked* by onIdleWake later, asynchronously, once a background
	// task finishes — never called during construction — so referencing it
	// here before its textual definition is safe.
	function makeBackgroundBash(runner: AgentRunner, sessionId: string): BashBackgroundDeps {
		const registry = new BackgroundTaskRegistry();
		registry.setOnIdleWake((text) => submit(sessionId, text));
		return { registry, followUpQueue: runner.followUpQueue, isRunning: () => runner.isRunning };
	}

	function createSessionInstance(personaName?: string, modelOverride?: string, cwdOverride?: string): WebAgentSession {
		const persona = personaName ? (resolvePersona(personaName) ?? currentPersona) : currentPersona;
		const model = modelOverride ?? result.session.model;
		const sessionCwd = cwdOverride ?? cwd;

		const session = createSession(model, sessionCwd);
		session.persona = persona.name;

		const runner = createAgentRunner();
		const ws: WebAgentSession = {
			id: session.id,
			session,
			runner,
			backgroundBash: makeBackgroundBash(runner, session.id),
			status: "idle",
			error: null,
			listeners: new Set(),
			systemPrompt: computeSystemPrompt(persona, model, sessionCwd),
		};

		sessions.set(session.id, ws);
		return ws;
	}

	function broadcast(ws: WebAgentSession, event: WebEvent): void {
		for (const listener of ws.listeners) {
			try {
				listener(event);
			} catch {
				// Listener threw — remove it to avoid poisoning the set.
			}
		}
	}

	/** Pushes a sidebar-friendly snapshot so every connected client (including
	 *  tabs that didn't initiate the turn) can update their session list
	 *  without a full refetch. */
	function broadcastSessionUpdate(ws: WebAgentSession): void {
		try {
			broadcast(ws, { type: "session_update", session: summaryFor(ws.session, ws.status) });
		} catch {
			// Defensive: summaryFor reads session.messages.length — if the run
			// left messages in an unexpected state, don't crash the broadcast.
		}
	}

	function submit(sessionId: string, text: string): void {
		const ws = sessions.get(sessionId);
		if (!ws) return;

		// Auto-title from the first-ever user message, same idea as a browser
		// tab title — only if nothing (auto or a manual rename) has set one yet.
		if (!ws.session.title && !ws.session.messages.some((m) => m.role === "user")) {
			ws.session.title = deriveTitle(text);
		}

		appendMessage(ws.session, { role: "user", content: text });
		broadcast(ws, { type: "status", status: "running" });
		ws.status = "running";
		ws.error = null;
		broadcastSessionUpdate(ws);

		const ac = new AbortController();
		ws.runner.startRun(ac);

		const persona = personas.find((p) => p.name === ws.session.persona) ?? currentPersona;

		// One `assistant_message` event fires per assistant completion this
		// turn, in the same order those completions get pushed onto `messages`
		// — collecting them here lets the `.then` below re-associate each
		// non-empty one with the assistant message it belongs to once the
		// final array (with real indices) comes back.
		const startCount = ws.session.messages.length;
		const thinkingByCompletion: string[] = [];
		// Save the session NOW — before the run starts — so the user's message
		// is persisted even if the process is killed mid-run (SIGTERM timeout,
		// OOM, crash). runAgentLoop works on a private copy of the array (see
		// its `const messages = [...initialMessages]`), so ws.session.messages
		// stays at the pre-run snapshot during the entire run. The `.then()`
		// below does the final authoritative save with assistant responses.
		saveSession(ws.session);

		// Read fresh each run (not captured once) so a mid-session /web toggle
		// takes effect on the very next turn — matches core/run.ts's headless
		// path, which does the same loadSettings() call per turn rather than
		// caching it at startup.
		const planMode = ws.session.mode === "plan";
		const disabledTools = new Set<string>(modeDisabledTools(planMode));
		if (loadSettings().webTools !== true) {
			disabledTools.add("web_search");
			disabledTools.add("web_fetch");
		}
		const planState = createPlanState(ws.session.id);
		planState.enabled = planMode;
		// Plan mode can run under a separate, usually-cheaper model (matches the
		// TUI's App.tsx activeModel calc) — this only affects THIS run, session.model
		// itself is untouched so leaving plan mode reverts automatically.
		const runModel = planMode && planModel ? planModel : ws.session.model;

		// Resolve per-slot provider credentials.
		const currentSettings = loadSettings();
		const providers = currentSettings.providers ?? [];
		const activeCreds = { baseURL: config.baseURL, apiKey: config.apiKey };
		const resolvedModelProvider =
			planMode && planModel && planModelProvider
				? resolveProvider(providers, planModelProvider, activeCreds)
				: undefined;
		const resolvedSubagentProvider = resolveProvider(providers, subagentModelProvider, activeCreds);

		runAgentLoop(ws.session.messages, {
			config,
			model: runModel,
			modelProvider: resolvedModelProvider,
			subagentModelProvider: resolvedSubagentProvider,
			cwd: ws.session.cwd ?? cwd,
			systemPrompt: ws.systemPrompt,
			signal: ac.signal,
			steeringQueue: ws.runner.steeringQueue,
			followUpQueue: ws.runner.followUpQueue,
			confirmBash: permissionMode === "bypass" ? undefined : async () => true,
			disabledTools,
			planState,
			mcpTools: mcpResult.toolDefinitions,
			mcpToolIndex: mcpResult.toolIndex,
			personas,
			currentPersona: persona.name,
			subagentPrompts: subPrompts,
			subagentModel,
			projectTrusted,
			sshHosts,
			backgroundBash: ws.backgroundBash,
			mcpPromptSuffix: formatMcpForPrompt(mcpResult),
			onMessagesChanged: (messages) => {
				ws.session.messages = messages;
				try {
					saveSession(ws.session);
				} catch {
					// Best-effort: disk full / permissions shouldn't kill the run.
				}
			},
			onEvent: (event: AgentEvent) => {
				if (event.type === "assistant_message") thinkingByCompletion.push(event.thinking ?? "");
				if (event.type === "usage") {
					addUsage(ws.session, event.usage, { subagent: event.subagent });
					if (!event.subagent) {
						ws.lastTurn = {
							generationMs: event.generationMs,
							tokensPerSecond:
								event.generationMs && event.usage.completionTokens
									? Math.round((event.usage.completionTokens / (event.generationMs / 1000)) * 10) / 10
									: undefined,
							completedAt: new Date().toISOString(),
						};
					}
				}
				broadcast(ws, event);
			},
		})
			.then((finalMessages) => {
				// Final authoritative save — onMessagesChanged has been snapshotting
				// intermediate progress (tool calls, partial replies) throughout the
				// run, so a crash only loses at most one event's worth of data.
				// This save adds reasoning metadata that the intermediate snapshots
				// don't carry.
				ws.session.messages = finalMessages;

				// Zip collected reasoning back onto the assistant messages this turn
				// added, in order — skips non-assistant messages (user/tool) so
				// interleaved steering/tool-result entries don't throw off the count.
				let completionIndex = 0;
				for (let i = startCount; i < finalMessages.length; i++) {
					if (finalMessages[i]!.role !== "assistant") continue;
					const thinking = thinkingByCompletion[completionIndex++];
					if (thinking) {
						ws.session.reasoning ??= {};
						ws.session.reasoning[i] = thinking;
					}
				}

				ws.status = "idle";
				ws.runner.endRun();
				// finalMessages is a fresh array from runAgentLoop — reset the
				// JSONL append counter so saveSession writes all messages.
				resetSavedMessageCount(ws.session);
				saveSession(ws.session);
				broadcast(ws, { type: "status", status: "idle" });
				broadcast(ws, {
					type: "session_end",
					usage: ws.session.usage,
					messageCount: ws.session.messages.length,
				});
				broadcastSessionUpdate(ws);
			})
			.catch((err: unknown) => {
				ws.status = "error";
				ws.error = err instanceof Error ? err.message : String(err);
				ws.runner.endRun();
				saveSession(ws.session);
				broadcast(ws, { type: "error", message: ws.error });
				broadcast(ws, { type: "status", status: "error" });
				broadcastSessionUpdate(ws);
			});
	}

	function abort(sessionId: string): void {
		const ws = sessions.get(sessionId);
		if (!ws) return;
		ws.runner.abort();
	}

	function closeSession(sessionId: string): boolean {
		const ws = sessions.get(sessionId);
		if (!ws) return false;
		if (ws.status === "running") ws.runner.abort();
		ws.backgroundBash.registry.killAll();
		saveSession(ws.session);
		// Told before removal, and before clearing listeners, so any open SSE
		// connection gets one last frame to close itself on (see server.ts).
		broadcast(ws, { type: "session_closed" });
		ws.listeners.clear();
		sessions.delete(sessionId);
		return true;
	}

	function subscribe(sessionId: string, callback: (event: WebEvent) => void): void {
		const ws = sessions.get(sessionId);
		if (!ws) return;
		ws.listeners.add(callback);
	}

	function unsubscribe(sessionId: string, callback: (event: WebEvent) => void): void {
		const ws = sessions.get(sessionId);
		if (!ws) return;
		ws.listeners.delete(callback);
	}

	/**
	 * Sessions only live in this Map once something in this process instance
	 * has touched them — a fresh `cast web` restart starts with an empty Map
	 * even though every prior session is still sitting on disk (autosaved,
	 * same as the TUI). This lazily loads one of those cold sessions into a
	 * real, fully-interactive WebAgentSession the first time anything asks
	 * for it by id — after which it behaves exactly like one created this
	 * process's lifetime (same Map entry, same runner).
	 */
	function hydrateSession(id: string): WebAgentSession | undefined {
		const session = loadSession(id);
		if (!session) return undefined;
		const persona = resolvePersona(session.persona ?? "") ?? currentPersona;
		const runner = createAgentRunner();
		const ws: WebAgentSession = {
			id: session.id,
			session,
			runner,
			backgroundBash: makeBackgroundBash(runner, session.id),
			status: "idle",
			error: null,
			listeners: new Set(),
			systemPrompt: computeSystemPrompt(persona, session.model, session.cwd ?? cwd, session.mode),
		};
		sessions.set(session.id, ws);
		return ws;
	}

	function getSession(id: string): WebAgentSession | undefined {
		return sessions.get(id) ?? hydrateSession(id);
	}

	function summaryFor(session: SessionState, status: WebAgentStatus): SessionSummary {
		return {
			id: session.id,
			persona: session.persona ?? currentPersona.name,
			model: session.model,
			cwd: session.cwd ?? cwd,
			title: session.title,
			pinned: session.pinned,
			status,
			messageCount: session.messages.length,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
		};
	}

	function listSessions(): SessionSummary[] {
		const out: SessionSummary[] = [];
		const seen = new Set<string>();
		for (const ws of sessions.values()) {
			out.push(summaryFor(ws.session, ws.status));
			seen.add(ws.id);
		}
		// Every other session that's ever been saved to disk (any project,
		// any prior process) — cold, not yet hydrated into a live runner, but
		// still a real thread the user should be able to find and reopen.
		for (const cold of listSessionSummaries()) {
			if (seen.has(cold.id)) continue;
			out.push({
				id: cold.id,
				persona: cold.persona ?? "coding",
				model: cold.model ?? "",
				cwd: cold.cwd ?? cwd,
				title: cold.title,
				pinned: cold.pinned,
				status: "idle",
				messageCount: cold.msgCount,
				createdAt: cold.createdAt ?? cold.updatedAt,
				updatedAt: cold.updatedAt,
			});
		}
		return out;
	}

	/** Splits "sub rest of args" into its first word and everything after —
	 * used by every command with sub-verbs (/mcp enable <name>, /plugin
	 * marketplace add <src>, ...) since the outer name/arg split in
	 * executeCommand only peels off the top-level command name. */
	function splitArg(s: string): [string, string] {
		const i = s.indexOf(" ");
		return i === -1 ? [s, ""] : [s.slice(0, i), s.slice(i + 1).trim()];
	}

	/** Truncated to a single-line preview — same idea as a browser tab title,
	 * not meant to hold the full first message. */
	function deriveTitle(text: string): string {
		const oneLine = text.replace(/\s+/g, " ").trim();
		return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
	}

	/** Same fallback chain the TUI's /reasoning uses: the meta captured at
	 * startup only matches the model cast launched with — a session that's
	 * since switched models (`/model`) falls back to whatever the provider's
	 * model list cache says about the model it's actually running now. */
	function reasoningOptionsFor(model: string): Array<{ value: string; label: string }> {
		const meta = reasoningMeta ?? getModelsCache().find((m) => m.id === model)?.reasoning;
		return getReasoningOptions(meta ?? null);
	}

	function renameSession(sessionId: string, title: string): boolean {
		const ws = sessions.get(sessionId);
		if (!ws) return false;
		ws.session.title = title.trim().slice(0, 200) || undefined;
		saveSession(ws.session);
		return true;
	}

	function pinSession(sessionId: string, pinned: boolean): boolean {
		const ws = sessions.get(sessionId);
		if (!ws) return false;
		ws.session.pinned = pinned || undefined;
		saveSession(ws.session);
		return true;
	}

	async function executeCommand(
		sessionId: string,
		command: string,
	): Promise<{ ok: boolean; result?: unknown; error?: string }> {
		const ws = sessions.get(sessionId);
		if (!ws) return { ok: false, error: "Session not found" };

		const cmd = command.trim();
		if (!cmd.startsWith("/")) return { ok: false, error: "Not a command" };

		const spaceIdx = cmd.indexOf(" ");
		const name = spaceIdx === -1 ? cmd : cmd.slice(0, spaceIdx);
		const arg = spaceIdx === -1 ? "" : cmd.slice(spaceIdx + 1).trim();
		const running = ws.status === "running";

		// isCommandBlocking is the single source of truth for which commands
		// require idle (shared with the /api/commands list the client uses to
		// grey out the palette) — reject early instead of duplicating the set.
		if (running && isCommandBlocking(cmd)) {
			return { ok: false, error: "Agent running — use /queue, /steer, or /abort" };
		}

		// Non-blocking commands — work while the agent is running. Mirrors
		// src/ui/commands.ts's /steer and /queue semantics (see there): with
		// nothing running, both just submit the message as a normal turn.
		if (name === "/help") {
			return { ok: true, result: getHelpText() };
		}
		if (name === "/current") {
			return {
				ok: true,
				result: {
					persona: ws.session.persona,
					model: ws.session.model,
					mode: ws.session.mode ?? "build",
					status: ws.status,
					messageCount: ws.session.messages.length,
					usage: ws.session.usage,
					lastTurn: ws.lastTurn,
					permissionMode,
					subagentModel: subagentModel ?? null,
					subagentModelProvider: subagentModelProvider ?? null,
					planModel: planModel ?? null,
					planModelProvider: planModelProvider ?? null,
				},
			};
		}
		if (name === "/usage") {
			return { ok: true, result: ws.session.usage };
		}
		if (name === "/repo") {
			const sessionCwd = ws.session.cwd ?? cwd;
			const git = (args: string[]) =>
				execFileSync("git", args, {
					cwd: sessionCwd,
					encoding: "utf-8",
					timeout: 3000,
					stdio: ["pipe", "pipe", "pipe"],
				}).trim();
			try {
				git(["rev-parse", "--is-inside-work-tree"]);
			} catch {
				return { ok: true, result: { cwd: sessionCwd, isGit: false } };
			}
			let branch = "—";
			let dirty = false;
			try {
				branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
			} catch {}
			try {
				dirty = git(["status", "--porcelain"]).length > 0;
			} catch {}
			return { ok: true, result: { cwd: sessionCwd, isGit: true, branch, dirty } };
		}
		if (name === "/rules") {
			return {
				ok: true,
				result: directoryRules.map((r) => ({
					id: r.id,
					name: r.name,
					description: r.description,
					applyMode: r.applyMode,
				})),
			};
		}
		if (name.startsWith("/rule:")) {
			const ruleId = name.slice("/rule:".length);
			if (!ruleId) return { ok: false, error: "Usage: /rule:<name>" };
			// Submits the rule body as a real user turn (matches the TUI's
			// agent.submit(formatRuleInvocation(rule)) — it's not a silent system-
			// prompt injection), so it needs the same idle gate a plain message
			// submit would get if the composer weren't already disabled while running.
			if (running) return { ok: false, error: "Agent running — use /queue, /steer, or /abort" };
			const rule = directoryRules.find((r) => r.id === ruleId) ?? directoryRules.find((r) => r.name === ruleId);
			if (!rule) return { ok: false, error: `Unknown rule: ${ruleId}. See /rules for the list.` };
			submit(sessionId, formatRuleInvocation(rule));
			return { ok: true, result: `Invoked rule: ${rule.name}` };
		}
		if (name === "/permissions") {
			// Global, like /reasoning and /web — `permissionMode` is bridge-level
			// mutable state read fresh by submit() on the next run.
			if (!arg) return { ok: true, result: { permissionMode } };
			if (arg !== "default" && arg !== "bypass") return { ok: false, error: "Usage: /permissions default|bypass" };
			permissionMode = arg;
			updateSettings({ permissionMode: arg });
			return { ok: true, result: { permissionMode: arg } };
		}
		if (name === "/web") {
			// A global setting (matches the TUI/`cast run`'s own /web and
			// core/run.ts) — takes effect on the NEXT turn in every session, since
			// submit() reads `loadSettings().webTools` fresh each run rather than
			// caching it, same as headless mode does.
			if (!arg) return { ok: true, result: { webTools: loadSettings().webTools === true } };
			if (arg !== "on" && arg !== "off") return { ok: false, error: "Usage: /web on|off" };
			updateSettings({ webTools: arg === "on" });
			return { ok: true, result: { webTools: arg === "on" } };
		}
		if (name === "/theme") {
			// A UI preference, not agent state — shared with the TUI's settings.json
			// `theme` field so picking one here also changes what `cast` shows next.
			if (!arg) {
				const current = loadSettings().theme ?? "cast";
				return { ok: true, result: { theme: current } };
			}
			const found = ALL_THEMES.find((t) => t.id === arg);
			if (!found) {
				return {
					ok: false,
					error: `Unknown theme: ${arg}. Available: ${ALL_THEMES.map((t) => t.id).join(", ")}`,
				};
			}
			updateSettings({ theme: found.id });
			return { ok: true, result: { theme: found.id, label: found.label, colors: found.colors } };
		}
		if (name === "/abort" || name === "/stop") {
			abort(sessionId);
			return { ok: true, result: "Aborted" };
		}
		if (name === "/sessions") {
			return { ok: true, result: listSessions() };
		}
		if (name === "/steer" || name === "/s") {
			if (!arg) return { ok: false, error: "Usage: /steer <message> — injects it into the running turn" };
			if (!running) {
				submit(sessionId, arg);
				return { ok: true, result: "Sent" };
			}
			ws.runner.steeringQueue.enqueue({ role: "user", content: arg });
			return { ok: true, result: "Steered into the running turn" };
		}
		if (name === "/queue" || name === "/q") {
			if (!arg) return { ok: false, error: "Usage: /queue <message> — runs after the current turn" };
			if (!running) {
				submit(sessionId, arg);
				return { ok: true, result: "Sent" };
			}
			ws.runner.followUpQueue.enqueue({ role: "user", content: arg });
			return { ok: true, result: "Queued for after this turn" };
		}
		if (name === "/queue-reset" || name === "/qr") {
			ws.runner.followUpQueue.clear();
			return { ok: true, result: "Queue cleared" };
		}

		// Everything below requires idle (enforced by the isCommandBlocking gate above).
		if (name === "/clear") {
			ws.session.messages = [];
			resetSavedMessageCount(ws.session);
			saveSession(ws.session);
			return { ok: true, result: "Context cleared" };
		}
		if (name === "/compact") {
			if (ws.session.messages.length === 0) return { ok: true, result: "Nothing to compact yet" };
			// Runs the same async summarization call `submit()` uses for the agent
			// loop itself — returns immediately (matching submit()'s own
			// fire-and-forget shape) and reports the outcome over SSE via the
			// existing "compaction" event, which the client already renders as a
			// system-message row (see runAgentLoop's own auto-compaction, which
			// broadcasts the identical event shape).
			ws.status = "running";
			broadcast(ws, { type: "status", status: "running" });
			compactSessionMessages(ws.session.messages, config, ws.session.model, undefined, undefined, (usage) =>
				addUsage(ws.session, usage),
			)
				.then((result) => {
					ws.status = "idle";
					if (result.compacted) {
						ws.session.messages = result.messages;
						resetSavedMessageCount(ws.session);
						broadcast(ws, {
							type: "compaction",
							messagesCompacted: result.messagesCompacted,
							tokensBefore: result.tokensBefore,
						});
					} else if (result.error) {
						broadcast(ws, { type: "error", message: `Compaction failed: ${result.error}` });
					}
					saveSession(ws.session);
					broadcast(ws, { type: "status", status: "idle" });
				})
				.catch((err: unknown) => {
					ws.status = "error";
					ws.error = err instanceof Error ? err.message : String(err);
					broadcast(ws, { type: "error", message: ws.error });
					broadcast(ws, { type: "status", status: "error" });
				});
			return { ok: true, result: "Compacting…" };
		}
		if (name === "/new") {
			const newWs = createSessionInstance(ws.session.persona ?? undefined, undefined, ws.session.cwd);
			return { ok: true, result: { sessionId: newWs.id } };
		}
		if (name === "/model") {
			if (!arg) return { ok: true, result: { model: ws.session.model } };
			ws.session.model = arg;
			ws.systemPrompt = computeSystemPrompt(
				resolvePersona(ws.session.persona ?? "") ?? currentPersona,
				arg,
				ws.session.cwd ?? cwd,
				ws.session.mode,
			);
			saveSession(ws.session);
			return { ok: true, result: { model: arg } };
		}
		if (name === "/reasoning") {
			const options = reasoningOptionsFor(ws.session.model);
			if (options.length === 0) {
				return {
					ok: true,
					result: {
						reasoningLevel: config.reasoningLevel,
						options: [],
						note: "This provider exposes no reasoning controls for this model.",
					},
				};
			}
			if (!arg)
				return {
					ok: true,
					result: { reasoningLevel: config.reasoningLevel, options: options.map((o) => o.value) },
				};
			if (!options.some((o) => o.value === arg)) {
				return {
					ok: false,
					error: `Unknown reasoning level: ${arg}. Options: ${options.map((o) => o.value).join(", ")}`,
				};
			}
			// Global, same as the TUI — `config` is a shared mutable object, so this
			// takes effect on the next turn in every session, not just this one.
			config.reasoningLevel = arg;
			updateSettings({ reasoningLevel: arg });
			return { ok: true, result: { reasoningLevel: arg } };
		}
		if (name === "/persona") {
			if (!arg) return { ok: true, result: { persona: ws.session.persona } };
			const persona = resolvePersona(arg);
			if (!persona) {
				return {
					ok: false,
					error: `Unknown persona: ${arg}. Available: ${personas.map((p) => p.name).join(", ")}`,
				};
			}
			ws.session.persona = persona.name;
			ws.systemPrompt = computeSystemPrompt(persona, ws.session.model, ws.session.cwd ?? cwd, ws.session.mode);
			saveSession(ws.session);
			return { ok: true, result: { persona: persona.name, label: persona.label } };
		}
		if (name === "/subagent-model") {
			if (!arg) return { ok: true, result: { subagentModel: subagentModel ?? null } };
			subagentModel = arg;
			updateSettings({ subagentModel: arg });
			return { ok: true, result: { subagentModel: arg } };
		}
		if (name === "/subagent-model-provider") {
			if (!arg) return { ok: true, result: { subagentModelProvider: subagentModelProvider ?? null } };
			if (arg === "off" || arg === "reset") {
				subagentModelProvider = undefined;
				updateSettings({ subagentModelProvider: undefined });
				return { ok: true, result: { subagentModelProvider: null } };
			}
			subagentModelProvider = arg;
			updateSettings({ subagentModelProvider: arg });
			return { ok: true, result: { subagentModelProvider: arg } };
		}
		if (name === "/plan-model") {
			if (!arg) return { ok: true, result: { planModel: planModel ?? null } };
			if (arg === "off" || arg === "reset") {
				planModel = undefined;
				updateSettings({ planModel: undefined });
				return { ok: true, result: { planModel: null } };
			}
			planModel = arg;
			updateSettings({ planModel: arg });
			return { ok: true, result: { planModel: arg } };
		}
		if (name === "/plan-model-provider") {
			if (!arg) return { ok: true, result: { planModelProvider: planModelProvider ?? null } };
			if (arg === "off" || arg === "reset") {
				planModelProvider = undefined;
				updateSettings({ planModelProvider: undefined });
				return { ok: true, result: { planModelProvider: null } };
			}
			planModelProvider = arg;
			updateSettings({ planModelProvider: arg });
			return { ok: true, result: { planModelProvider: arg } };
		}
		if (name === "/plan" || name === "/build") {
			const mode = name === "/plan" ? "plan" : "build";
			ws.session.mode = mode;
			ws.systemPrompt = computeSystemPrompt(
				resolvePersona(ws.session.persona ?? "") ?? currentPersona,
				ws.session.model,
				ws.session.cwd ?? cwd,
				mode,
			);
			saveSession(ws.session);
			return {
				ok: true,
				result:
					mode === "plan"
						? "Plan mode — read-only exploration and planning; /build to exit"
						: "Build mode — full toolset",
			};
		}
		if (name === "/continue") {
			const others = listSessions()
				.filter((s) => s.id !== sessionId)
				.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
			if (others.length === 0) return { ok: false, error: "No other sessions to continue" };
			return { ok: true, result: { sessionId: others[0]!.id } };
		}
		if (name === "/reload") {
			const sessionCwd = ws.session.cwd ?? cwd;
			try {
				projectTrusted = await resolveProjectTrustForCwd(projectDeps, sessionCwd);
				const skillsResult = await resolveSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
				skillsPromptSuffix = skillsResult.skillsPromptSuffix;
				const rules = resolveRulesForCwd(sessionCwd, projectTrusted);
				rulesSuffix = rules.alwaysApplySuffix;
				rulesLazySuffix = rules.lazySuffix;
				directoryRules = rules.directoryRules;
				personas = resolvePersonasForCwd(sessionCwd, projectTrusted).personas;
				await closeMcpConnections(mcpResult.connections);
				mcpResult = await resolveMcpForCwd(
					projectDeps,
					sessionCwd,
					projectTrusted,
					loadSettings().disabledMcpServers ?? [],
				);
				recomputeAllSystemPrompts();
				return { ok: true, result: "Reloaded skills, rules, MCP, and personas for this directory" };
			} catch (err) {
				return { ok: false, error: `Reload failed: ${err instanceof Error ? err.message : String(err)}` };
			}
		}
		if (name === "/mcp") {
			const [sub, rest] = splitArg(arg);
			const sessionCwd = ws.session.cwd ?? cwd;
			if (!sub || sub === "list") {
				return {
					ok: true,
					result: mcpResult.allServerNames.map((n) => ({
						name: n,
						source: mcpResult.serverSources[n] ?? "global",
						connected: mcpResult.connections.some((c) => c.serverName === n),
						disabled: (loadSettings().disabledMcpServers ?? []).includes(n),
					})),
				};
			}
			if (sub === "help") {
				return {
					ok: true,
					result: "/mcp list · /mcp enable <name> · /mcp disable <name> · /mcp uninstall <name>",
				};
			}
			if (sub === "enable" || sub === "disable") {
				if (!rest) return { ok: false, error: `Usage: /mcp ${sub} <name>` };
				const settings = loadSettings();
				const disabled = new Set(settings.disabledMcpServers ?? []);
				if (sub === "disable") disabled.add(rest);
				else disabled.delete(rest);
				updateSettings({ disabledMcpServers: [...disabled] });
				try {
					await closeMcpConnections(mcpResult.connections);
					mcpResult = await resolveMcpForCwd(projectDeps, sessionCwd, projectTrusted, [...disabled]);
					recomputeAllSystemPrompts();
					return { ok: true, result: `MCP server "${rest}" ${sub}d` };
				} catch (err) {
					return { ok: false, error: `Reconnect failed: ${err instanceof Error ? err.message : String(err)}` };
				}
			}
			if (sub === "uninstall") {
				if (!rest) return { ok: false, error: "Usage: /mcp uninstall <name>" };
				const removed = removeMcpServerFromDisk(rest, sessionCwd, projectTrusted);
				if (!removed) return { ok: false, error: `Unknown or already-removed MCP server: ${rest}` };
				try {
					await closeMcpConnections(mcpResult.connections);
					mcpResult = await resolveMcpForCwd(
						projectDeps,
						sessionCwd,
						projectTrusted,
						loadSettings().disabledMcpServers ?? [],
					);
					recomputeAllSystemPrompts();
					return { ok: true, result: `Uninstalled MCP server "${rest}" (${removed.origin})` };
				} catch (err) {
					return { ok: false, error: `Reconnect failed: ${err instanceof Error ? err.message : String(err)}` };
				}
			}
			return { ok: false, error: `Unknown /mcp subcommand: ${sub}` };
		}
		if (name === "/skills") {
			const [sub, rest] = splitArg(arg);
			const sessionCwd = ws.session.cwd ?? cwd;
			if (!sub || sub === "list") {
				const discovered = discoverSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
				const disabled = new Set(loadSettings().disabledSkills ?? []);
				return {
					ok: true,
					result: discovered.map((s) => ({
						name: s.name,
						source: s.source,
						description: s.description,
						enabled: !disabled.has(s.name) && s.pluginEnabled !== false,
						uninstallable: isUninstallableSkill(s),
					})),
				};
			}
			if (sub === "help") {
				return {
					ok: true,
					result: "/skills list · /skills enable <name> · /skills disable <name> · /skills uninstall <name>",
				};
			}
			if (sub === "enable" || sub === "disable") {
				if (!rest) return { ok: false, error: `Usage: /skills ${sub} <name>` };
				const settings = loadSettings();
				const disabled = new Set(settings.disabledSkills ?? []);
				if (sub === "disable") disabled.add(rest);
				else disabled.delete(rest);
				updateSettings({ disabledSkills: [...disabled] });
				const skillsResult = await resolveSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
				skillsPromptSuffix = skillsResult.skillsPromptSuffix;
				recomputeAllSystemPrompts();
				return { ok: true, result: `Skill "${rest}" ${sub}d` };
			}
			if (sub === "uninstall") {
				if (!rest) return { ok: false, error: "Usage: /skills uninstall <name>" };
				const discovered = discoverSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
				const skill = discovered.find((s) => s.name === rest);
				if (!skill) return { ok: false, error: `Unknown skill: ${rest}` };
				if (!isUninstallableSkill(skill))
					return { ok: false, error: `"${rest}" isn't a removable skill (builtin/plugin)` };
				uninstallUserSkill(skill);
				const skillsResult = await resolveSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
				skillsPromptSuffix = skillsResult.skillsPromptSuffix;
				recomputeAllSystemPrompts();
				return { ok: true, result: `Uninstalled skill "${rest}"` };
			}
			return { ok: false, error: `Unknown /skills subcommand: ${sub}` };
		}
		if (name === "/plugin") {
			const [sub, rest] = splitArg(arg);
			const sessionCwd = ws.session.cwd ?? cwd;
			const settings = loadSettings();
			try {
				if (!sub || sub === "list") {
					return { ok: true, result: listInstalledPlugins(settings) };
				}
				if (sub === "help") {
					return {
						ok: true,
						result:
							"/plugin list · /plugin install <name@marketplace> · /plugin uninstall <name@marketplace> · " +
							"/plugin enable/disable <name@marketplace> · /plugin marketplace add/list/remove/update",
					};
				}
				if (sub === "install") {
					if (!rest) return { ok: false, error: "Usage: /plugin install <name@marketplace>" };
					const r = installPlugin(rest, settings);
					updateSettings({ enabledPlugins: r.enabledPlugins });
					const skillsResult = await resolveSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
					skillsPromptSuffix = skillsResult.skillsPromptSuffix;
					recomputeAllSystemPrompts();
					return { ok: true, result: `Installed plugin "${r.id}"` };
				}
				if (sub === "uninstall") {
					if (!rest) return { ok: false, error: "Usage: /plugin uninstall <name@marketplace>" };
					const r = uninstallPlugin(rest, settings);
					updateSettings({ enabledPlugins: r.enabledPlugins });
					const skillsResult = await resolveSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
					skillsPromptSuffix = skillsResult.skillsPromptSuffix;
					recomputeAllSystemPrompts();
					return { ok: true, result: `Uninstalled plugin "${r.id}"` };
				}
				if (sub === "enable" || sub === "disable") {
					if (!rest) return { ok: false, error: `Usage: /plugin ${sub} <name@marketplace>` };
					const r = setPluginEnabled(rest, sub === "enable", settings);
					updateSettings({ enabledPlugins: r.enabledPlugins });
					const skillsResult = await resolveSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
					skillsPromptSuffix = skillsResult.skillsPromptSuffix;
					recomputeAllSystemPrompts();
					return { ok: true, result: `Plugin "${r.id}" ${sub}d` };
				}
				if (sub === "marketplace") {
					const [subsub, rest2] = splitArg(rest);
					if (!subsub || subsub === "list") {
						if (rest2) return { ok: true, result: getMarketplaceCatalog(rest2).plugins };
						return { ok: true, result: listKnownMarketplaces() };
					}
					if (subsub === "add") {
						if (!rest2) return { ok: false, error: "Usage: /plugin marketplace add <owner/repo|url|path>" };
						const mp = addMarketplace(rest2);
						return { ok: true, result: `Added marketplace "${mp.name}"` };
					}
					if (subsub === "remove") {
						if (!rest2) return { ok: false, error: "Usage: /plugin marketplace remove <name>" };
						const removedIds = removeMarketplace(rest2);
						if (removedIds.length > 0) {
							const enabled = { ...(settings.enabledPlugins ?? {}) };
							for (const id of removedIds) delete enabled[id];
							updateSettings({ enabledPlugins: enabled });
							const skillsResult = await resolveSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
							skillsPromptSuffix = skillsResult.skillsPromptSuffix;
							recomputeAllSystemPrompts();
						}
						return { ok: true, result: `Removed marketplace "${rest2}"` };
					}
					if (subsub === "update") {
						if (!rest2) return { ok: false, error: "Usage: /plugin marketplace update <name>" };
						const mp = updateMarketplace(rest2);
						return { ok: true, result: `Updated marketplace "${mp.name}"` };
					}
					return { ok: false, error: `Unknown /plugin marketplace subcommand: ${subsub}` };
				}
				return { ok: false, error: `Unknown /plugin subcommand: ${sub}` };
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		}
		if (name === "/provider") {
			const [sub, rest] = splitArg(arg);
			const settings = loadSettings();
			const providers = settings.providers ?? [];
			if (!sub || sub === "list") {
				return {
					ok: true,
					result: providers.map((p) => ({ name: p.name, url: p.url, active: p.url === config.baseURL })),
				};
			}
			if (sub === "delete") {
				if (!rest) return { ok: false, error: "Usage: /provider delete <name>" };
				const remaining = providers.filter((p) => p.name !== rest);
				if (remaining.length === providers.length) return { ok: false, error: `Unknown provider: ${rest}` };
				updateSettings({ providers: remaining });
				return { ok: true, result: `Deleted provider "${rest}"` };
			}
			if (sub === "add") {
				// Flat form since there's no wizard on the web: /provider add <name> <url> <apiKey>
				const parts = rest.split(/\s+/);
				const [pname, url, apiKey] = parts;
				if (!pname || !url || !apiKey) return { ok: false, error: "Usage: /provider add <name> <url> <apiKey>" };
				const next = [...providers.filter((p) => p.name !== pname), { name: pname, url, apiKey }];
				updateSettings({ providers: next });
				return { ok: true, result: `Added provider "${pname}" (not switched — use /provider ${pname})` };
			}
			// Bare name — switch to it.
			const target = providers.find((p) => p.name === sub);
			if (!target) return { ok: false, error: `Unknown provider: ${sub}. See /provider for the list.` };
			const probe = await probeProvider({ ...config, baseURL: target.url, apiKey: target.apiKey });
			if (probe !== "ok" && probe !== "unknown") {
				return { ok: false, error: `Provider "${sub}" isn't reachable (${probe}) — not switched` };
			}
			config.baseURL = target.url;
			config.apiKey = target.apiKey;
			updateSettings({ providerUrl: target.url, apiKey: target.apiKey });
			return { ok: true, result: `Switched to provider "${sub}" — pick a model with /model` };
		}
		if (name === "/ssh") {
			const [sub, rest] = splitArg(arg);
			if (!sub || sub === "list") {
				return {
					ok: true,
					result: sshHosts.map((h) => ({ name: h.name, host: h.host, username: h.username, port: h.port })),
				};
			}
			if (sub === "remove") {
				if (!rest) return { ok: false, error: "Usage: /ssh remove <name>" };
				const remaining = sshHosts.filter((h) => h.name !== rest);
				if (remaining.length === sshHosts.length) return { ok: false, error: `Unknown host: ${rest}` };
				sshHosts = remaining;
				saveSshConfig(sshHosts);
				return { ok: true, result: `Removed host "${rest}"` };
			}
			if (sub === "add") {
				// Flat form (no wizard): /ssh add <name> <host> [username] [port] [keyPath]
				// "-" is an explicit placeholder for a skipped optional field (so a
				// later positional arg, e.g. port, can be given without the earlier
				// one) — it never means a literal username/key path of "-".
				const parts = rest.split(/\s+/).map((p) => (p === "-" ? undefined : p));
				const [hname, host, username, portStr, keyPath] = parts;
				if (!hname || !host)
					return { ok: false, error: "Usage: /ssh add <name> <host> [username] [port] [keyPath]" };
				const port = portStr ? Number.parseInt(portStr, 10) : undefined;
				sshHosts = [...sshHosts.filter((h) => h.name !== hname), { name: hname, host, username, port, keyPath }];
				saveSshConfig(sshHosts);
				return { ok: true, result: `Added host "${hname}"` };
			}
			return { ok: false, error: `Unknown /ssh subcommand: ${sub}` };
		}

		return { ok: false, error: `Unknown command: ${cmd}` };
	}

	function getConfig() {
		return {
			baseURL: config.baseURL,
			model: result.session.model,
			persona: currentPersona.name,
			theme: loadSettings().theme ?? "cast",
			cwd,
		};
	}

	function getPersonas() {
		return personas.map((p) => ({
			name: p.name,
			label: p.label,
			description: p.description,
			source: p.source,
		}));
	}

	function getThemes() {
		return ALL_THEMES.map((t) => ({ id: t.id, label: t.label, description: t.description, colors: t.colors }));
	}

	/** Live provider /v1/models call — same one the TUI's /model picker makes
	 * (core/config.ts's fetchModels), fetched fresh per request rather than
	 * cached, since a stale list would just silently hide newly available
	 * models from the picker. */
	async function getModels(providerName?: string): Promise<{ models: ModelInfo[]; error?: string }> {
		let fetchConfig = config;
		if (providerName) {
			const currentSettings = loadSettings();
			const provider = (currentSettings.providers ?? []).find((p) => p.name === providerName);
			if (provider) fetchConfig = { ...config, baseURL: provider.url, apiKey: provider.apiKey };
		}
		const result = await fetchModels(fetchConfig);
		if (result.ok && result.models) {
			if (!providerName) setModelsCache(result.models);
			return { models: result.models };
		}
		return { models: [], error: result.error };
	}

	function getCachedModels(): { models: ModelInfo[] } {
		return { models: getModelsCache() };
	}

	function saveSshKey(name: string, keyContent: string): { ok: boolean; path?: string; error?: string } {
		try {
			const keysDir = join(homedir(), ".cast", "keys");
			if (!existsSync(keysDir)) mkdirSync(keysDir, { recursive: true });
			const keyPath = join(keysDir, name);
			writeFileSync(keyPath, keyContent.endsWith("\n") ? keyContent : `${keyContent}\n`, "utf-8");
			chmodSync(keyPath, 0o600);
			return { ok: true, path: keyPath };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	function getReasoningOptionsForSession(sessionId: string): { options: Array<{ value: string; label: string }> } {
		const ws = sessions.get(sessionId) ?? hydrateSession(sessionId);
		const model = ws?.session.model ?? result.session.model;
		return { options: reasoningOptionsFor(model) };
	}

	function suggestCommand(sessionId: string, input: string): Array<{ value: string; label: string }> {
		const trimmed = input.trim();
		if (!trimmed.startsWith("/")) return [];
		const spaceIdx = trimmed.indexOf(" ");
		const cmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
		const arg = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
		const settings = loadSettings();

		if (cmd === "/mcp") {
			if (!arg) return ["list", "enable", "disable", "uninstall", "help"].map((v) => ({ value: v, label: v }));
			const [sub] = arg.split(/\s+/);
			if (sub === "enable") {
				const disabled = new Set(settings.disabledMcpServers ?? []);
				return mcpResult.allServerNames.filter((n) => disabled.has(n)).map((v) => ({ value: v, label: v }));
			}
			if (sub === "disable") {
				const disabled = new Set(settings.disabledMcpServers ?? []);
				return mcpResult.allServerNames.filter((n) => !disabled.has(n)).map((v) => ({ value: v, label: v }));
			}
			if (sub === "uninstall") return mcpResult.allServerNames.map((v) => ({ value: v, label: v }));
			return [];
		}

		if (cmd === "/skills") {
			if (!arg) return ["list", "enable", "disable", "uninstall", "help"].map((v) => ({ value: v, label: v }));
			const [sub] = arg.split(/\s+/);
			const sessionCwd = sessions.get(sessionId)?.session.cwd ?? cwd;
			const discovered = discoverSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
			if (sub === "enable") {
				const disabled = new Set(settings.disabledSkills ?? []);
				return discovered.filter((s) => disabled.has(s.name)).map((s) => ({ value: s.name, label: s.description }));
			}
			if (sub === "disable") {
				const disabled = new Set(settings.disabledSkills ?? []);
				return discovered
					.filter((s) => !disabled.has(s.name))
					.map((s) => ({ value: s.name, label: s.description }));
			}
			if (sub === "uninstall")
				return discovered.filter(isUninstallableSkill).map((s) => ({ value: s.name, label: s.description }));
			return [];
		}

		if (cmd === "/plugin") {
			if (!arg)
				return ["list", "install", "uninstall", "enable", "disable", "marketplace", "help"].map((v) => ({
					value: v,
					label: v,
				}));
			const [sub] = arg.split(/\s+/);
			if (sub === "marketplace" && !arg.slice(sub.length).trim())
				return ["list", "add", "remove", "update"].map((v) => ({ value: v, label: v }));
			if (sub === "enable" || sub === "disable" || sub === "uninstall") {
				return listInstalledPlugins(settings).map((p) => ({ value: p.id, label: p.description ?? p.id }));
			}
			if (sub === "install") {
				const catalogs = listKnownMarketplaces();
				const items: Array<{ value: string; label: string }> = [];
				for (const mp of catalogs) {
					try {
						const cat = getMarketplaceCatalog(mp.name);
						for (const p of cat.plugins) items.push({ value: p.name, label: p.description ?? p.name });
					} catch {
						/* skip broken catalogs */
					}
				}
				return items;
			}
			return [];
		}

		if (cmd === "/provider") {
			const providers = settings.providers ?? [];
			if (!arg)
				return ["list", "add", "delete", ...providers.map((p) => p.name)].map((v) => ({ value: v, label: v }));
			const [sub] = arg.split(/\s+/);
			if (sub === "delete") return providers.map((p) => ({ value: p.name, label: p.name }));
			return [];
		}

		if (cmd === "/ssh") {
			if (!arg) return ["list", "add", "remove"].map((v) => ({ value: v, label: v }));
			const [sub] = arg.split(/\s+/);
			if (sub === "remove") return sshHosts.map((h) => ({ value: h.name, label: h.name }));
			return [];
		}

		if (cmd === "/permissions") {
			if (!arg) return ["default", "bypass"].map((v) => ({ value: v, label: v }));
			return [];
		}

		if (cmd === "/plan-model") {
			if (!arg) {
				const models = getModelsCache() ?? [];
				return [
					...models.map((m) => ({ value: m.id, label: m.id })),
					{ value: "off", label: "off" },
					{ value: "reset", label: "reset" },
				];
			}
			return [];
		}

		if (cmd === "/subagent-model") {
			if (!arg) {
				const models = getModelsCache() ?? [];
				return models.map((m) => ({ value: m.id, label: m.id }));
			}
			return [];
		}

		return [];
	}
	return {
		createSession: createSessionInstance,
		getSession,
		listSessions,
		closeSession,
		renameSession,
		pinSession,
		submit,
		abort,
		subscribe,
		unsubscribe,
		executeCommand,
		getConfig,
		getPersonas,
		getThemes,
		getModels,
		getCachedModels,
		saveSshKey,
		getReasoningOptionsForSession,
		suggestCommand,
	};
}

function getHelpText(): string {
	// No column-padding here — this renders through the same proportional-font
	// markdown pipe as chat prose, where fixed-width alignment doesn't hold.
	// Hidden commands (MCP/skills/plugins/provider/SSH/theme/...) live in the
	// Settings modal now, not this list — repeating them here would be the
	// exact chat clutter that modal exists to avoid.
	const visible = SLASH_COMMANDS.filter((c) => !c.hidden);
	const lines = visible.map((c) => `- \`${c.name}\` — ${c.description}`);
	const blocking = visible.filter((c) => c.blocking).map((c) => c.name);
	return [
		"**Available commands:**",
		"",
		...lines,
		"",
		`*Blocking (require idle): ${blocking.join(", ")}. Everything else works while the agent runs.*`,
		"",
		"*MCP, skills, plugins, provider, SSH, theme, model/reasoning details, and usage live in Settings (gear icon).*",
	].join("\n");
}
