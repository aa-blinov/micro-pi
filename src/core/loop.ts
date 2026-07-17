import { setMaxListeners } from "node:events";
import { basename, join } from "node:path";
import {
	formatPostCompactReminder,
	injectPostCompactReminder,
	type PostCompactReminderState,
	reminderStateFromPlan,
} from "./compaction-reminder.ts";
import type { AppConfig } from "./config.ts";
import { matchesToolsAllowlist } from "./frontmatter.ts";
import type { Message, Tool, Usage } from "./llm.ts";
import {
	applyCacheControl,
	createClient,
	describeTurnError,
	EMPTY_ASSISTANT_PLACEHOLDER,
	isContextOverflow,
	streamAndCollect,
} from "./llm.ts";
import type { McpToolHandle } from "./mcp.ts";
import {
	buildOpenWorkGateExhaustedReminder,
	collectOpenWorkSteps,
	defaultOpenWorkGateConfig,
	evaluateOpenWorkGate,
	isOpenWorkGateActive,
	type OpenWorkGateConfig,
} from "./open-work-gate.ts";
import type { Persona } from "./personas.ts";
import {
	checkReadOnlyCommand,
	listPlanNames,
	planChecklistState,
	readActivePlan,
	TERMINAL_TOOL_NAMES,
} from "./plan.ts";
import { promptsDir, readRequiredPrompt } from "./prompts.ts";
import { compactMessages, estimateTokens, fileTagsFromCompactionSummary, shouldCompact } from "./session.ts";
import type { SshHost } from "./ssh.ts";
import type { SubagentPrompt } from "./subagents.ts";
import { type ConfirmBash, createToolExecutor, getToolDefinitions, type ToolResult } from "./tools.ts";

// How many identical consecutive tool calls (same name + same args) before
// we treat it as a doom loop and block execution. Matches opencode's
// DOOM_LOOP_THRESHOLD — the model gets an error result and must try something
// different.
const DOOM_LOOP_THRESHOLD = 3;

// Terminal (signal) tools: once one succeeds, the turn ends — the UI opens a
// mode-transition dialog when the run settles. Enforced by the loop, not by
// asking the model to stop: a model that kept calling plan_done with a slightly
// reworded summary used to keep the run alive indefinitely (and slipped past
// the doom-loop detector, which keys on exact args). See plan.ts.
const TERMINAL_TOOLS = new Set<string>(TERMINAL_TOOL_NAMES);

// Common wrong tool names models reach for (trained on other harnesses) mapped
// to cast's real tools — so a hallucinated call gets pointed at the right tool
// instead of a bare "Unknown tool", which some models retry identically until
// the doom-loop guard trips.
const TOOL_ALIASES: Record<string, string> = {
	// Pre-rename cast name — still accepted via normalizeToolName; kept here
	// so a bare unknown-path message can point at `glob` if remapping is skipped.
	find: "glob",
	search: "grep",
	search_files: "grep",
	ripgrep: "grep",
	view: "read",
	cat: "read",
	open: "read",
	list_dir: "ls",
	list_files: "ls",
	str_replace: "edit",
	str_replace_editor: "edit",
	apply_patch: "edit",
	create_file: "write",
	run: "bash",
	shell: "bash",
	run_command: "bash",
	execute: "bash",
};

/** Legacy tool names rewritten to the current advertised name before dispatch. */
const TOOL_RENAMES: Record<string, string> = {
	find: "glob",
};

function normalizeToolName(name: string): string {
	return TOOL_RENAMES[name] ?? name;
}

/** Levenshtein distance, capped small — just enough to catch a typo'd tool name. */
function editDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	let prev = Array.from({ length: n + 1 }, (_, i) => i);
	let curr = new Array<number>(n + 1);
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[n]!;
}

/** Error result for a tool name that isn't advertised: name the closest real
 * tool (alias table first, then nearest by edit distance) and list what's
 * available, so the model corrects instead of retrying the fabricated name. */
function unknownToolResult(name: string, available: string[]): ToolResult {
	const aliased = TOOL_ALIASES[name.toLowerCase()];
	const suggestion =
		aliased && available.includes(aliased)
			? aliased
			: available
					.map((t) => ({ t, d: editDistance(name.toLowerCase(), t.toLowerCase()) }))
					.filter((x) => x.d <= Math.max(2, Math.floor(name.length / 3)))
					.sort((a, b) => a.d - b.d)[0]?.t;
	const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
	return {
		content: `Unknown tool "${name}".${hint} Available tools: ${available.join(", ")}. Call one of these — do not retry "${name}".`,
		isError: true,
	};
}

// Prompts for the LLM call that summarizes old messages during compaction —
// content, not code, so they live in prompts/ alongside the persona files
// instead of as inline strings here. Two variants (matching pi): a fresh
// summary when this is the first compaction this session has hit, or an
// update-in-place instruction set when compactMessages found a previous
// summary to fold new messages into.
const COMPACTION_SYSTEM_PROMPT = readRequiredPrompt(promptsDir, "compaction-system.md");
const COMPACTION_PROMPT = readRequiredPrompt(promptsDir, "compaction.md");
const COMPACTION_UPDATE_PROMPT = readRequiredPrompt(promptsDir, "compaction-update.md");
// Mode prompts live under prompts/modes/ — one file per agent mode, so new
// modes slot in beside these. Plan mode: restriction block prepended to the
// system prompt while /plan is active. Build mode: mirror of the plan block,
// injected once plan mode is exited and a plan file exists for the session, so
// the approved plan keeps steering the implementation — and survives
// compaction, which would otherwise drop it from the conversation. {{PLAN}} is
// replaced with the plan file content.
const PLAN_MODE_PROMPT = readRequiredPrompt(promptsDir, join("modes", "plan-mode.md"));
const BUILD_MODE_PROMPT = readRequiredPrompt(promptsDir, join("modes", "build-mode.md"));
// Shown instead of the full mirror once every checklist item is checked — a
// fully executed plan should stop steering (and stop costing tokens); the file
// stays on disk for reference. {{NAME}}/{{PATH}} are replaced.
const BUILD_MODE_DONE_PROMPT = readRequiredPrompt(promptsDir, join("modes", "build-mode-done.md"));
// Appended to the compaction prompt while plan mode is active: exploration
// findings not yet written into the plan file must survive the summary.
// Exported for the manual /compact command, which runs outside the loop.
export const PLAN_COMPACTION_PROMPT = readRequiredPrompt(promptsDir, join("modes", "plan-compaction.md"));
// One-liner for subagents running under readOnlyBash (plan-mode parent): they
// don't get the full plan-mode block (it references authoring tools they lack),
// but they must know why a mutating bash command bounces.
const READONLY_BASH_NOTE =
	"bash is INSPECTION-ONLY in this session: pipelines of read-only binaries (ls, cat, grep, find, wc, diff, git log/show/diff/status/blame, …) pass; anything that writes or runs other programs is rejected.";

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
	/** Extra mode-specific summarization guidance (e.g. plan mode: keep
	 * exploration findings not yet written into the plan file). */
	extraInstructions?: string,
	/** Live session state to preserve in a post-compact `<system-reminder>`. */
	reminderState?: PostCompactReminderState,
): Promise<CompactSessionResult> {
	const client = createClient(config);
	try {
		const result = await compactMessages(
			messages,
			async (text, previousSummary) => {
				const basePrompt = previousSummary
					? `<conversation>\n${text}\n</conversation>\n\n<previous-summary>\n${previousSummary}\n</previous-summary>\n\n${COMPACTION_UPDATE_PROMPT}`
					: `<conversation>\n${text}\n</conversation>\n\n${COMPACTION_PROMPT}`;
				const promptText = extraInstructions ? `${basePrompt}\n\n${extraInstructions}` : basePrompt;
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
			// Grok-build shape: reminder is a separate trailing message, never
			// embedded in the summary. Omit entirely when nothing actionable.
			const fileTags = fileTagsFromCompactionSummary(result.summary.summary);
			injectPostCompactReminder(
				result.messages,
				formatPostCompactReminder({
					...reminderState,
					modifiedFiles: reminderState?.modifiedFiles ?? fileTags.modifiedFiles,
				}),
			);
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
	| { type: "doom_loop"; tool: string; attempts: number }
	/** Turn-end gate forced another sampling round because plan steps remain open. */
	| { type: "open_work_gate"; fires: number; openSteps: number }
	/** Gate hit its per-prompt cap and allowed the turn to end. */
	| { type: "open_work_gate_exhausted"; openSteps: number; maxFires: number }
	| { type: "retry"; attempt: number; maxAttempts: number; reason: string }
	// generationMs is only set for the main completion's usage — compaction's
	// own summarization call reports usage too (for cumulative cost tracking)
	// but isn't a user-facing turn, so there's no "last request" TPS to show for it.
	| { type: "usage"; usage: Usage; generationMs?: number; subagent?: boolean }
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
	/** Definitions for connected MCP servers' tools, appended to the built-in ones. */
	mcpTools?: Tool[];
	/** Dispatch table for mcpTools — checked before falling back to the built-in executor. */
	mcpToolIndex?: Map<string, McpToolHandle>;
	/** Available personas for the task tool. */
	personas?: Persona[];
	/** Current persona name (inherited by subagents by default). */
	currentPersona?: string;
	/** Subagent prompts for the task tool. */
	subagentPrompts?: SubagentPrompt[];
	/** Model override for subagents (falls back to main model if undefined). */
	subagentModel?: string;
	/** Tool names to exclude from the definitions sent to the model. */
	disabledTools?: Set<string>;
	/**
	 * Optional allowlist for *built-in* tools only. Entries are exact names
	 * or `*`-globs (`plan_*`, `web_*`). When set, only matching builtin names
	 * are advertised and executable (after `disabledTools`). Connected MCP
	 * tools are never filtered by this list — they come from the user's
	 * session config, not the persona/subagent role. Used by subagents from
	 * frontmatter `tools:`; for the main agent, derived from the active
	 * persona when omitted.
	 */
	allowedTools?: string[];
	/**
	 * Whether the project cwd is trusted — used when spawning subagents that
	 * opt into AGENTS.md injection (`agentsMd: true`, the default).
	 */
	projectTrusted?: boolean;
	/** Plan mode state — when enabled, injects plan system prompt block. */
	planState?: import("./plan.ts").PlanState;
	/** Restrict bash to the read-only allowlist without the rest of plan mode.
	 * Used for subagents spawned from a plan-mode parent: they inherit the
	 * inspection-only bash but not the authoring tools or the plan prompt
	 * (their planState arrives with enabled=false). Implied by
	 * planState.enabled for the main agent. */
	readOnlyBash?: boolean;
	/** promptTokens from the most recent API response — used by shouldCompact
	 * as the authoritative context size instead of character-based estimation. */
	lastPromptTokens?: number;
	/**
	 * Optional per-turn system prompt rebuild. Called before every model
	 * request (each inner tool-call iteration, not just once per turn) with
	 * the current user text and accumulated context files. Rebuilding per
	 * request is what lets a rule auto-attach *within the same turn*: the
	 * model reads a file, contextFiles grows, and the very next request
	 * already carries the matching rule. Returns the system prompt to use.
	 */
	rebuildSystemPrompt?: (context: { userText: string; contextFiles: string[] }) => string;
	/**
	 * Session-scoped list of context files (paths from read/write/edit tool
	 * calls), accumulated in place across successive runAgentLoop calls. Pass
	 * the same array every submit so a file referenced in one message keeps a
	 * glob rule attached for the rest of the session; omitted ⇒ a fresh
	 * per-call array (rules only auto-attach within a single submit).
	 */
	contextFiles?: string[];
	/** Configured SSH hosts — when non-empty, the `ssh` tool is registered. */
	sshHosts?: SshHost[];
	/**
	 * Turn-end open-work gate. When omitted, defaults to enabled with
	 * `DEFAULT_OPEN_WORK_GATE_MAX_FIRES`. Still requires build mode + an
	 * active plan on disk (`isOpenWorkGateActive`).
	 */
	openWorkGate?: Partial<OpenWorkGateConfig>;
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

	// The same signal is reused across every LLM request, compaction call,
	// and tool execution in the loop. Each call may attach an abort listener
	// (OpenAI SDK, child-process kill handlers, etc.). Raise the cap once so
	// Node doesn't warn on long-running agentic sessions.
	if (signal) setMaxListeners(100, signal);
	const currentPersonaObj = loopConfig.personas?.find((p) => p.name === loopConfig.currentPersona);
	const subagentsEnabled = currentPersonaObj?.subagents === true;
	const subagentNames = subagentsEnabled ? loopConfig.subagentPrompts?.map((p) => p.name) : undefined;
	const sshHostNames = loopConfig.sshHosts?.map((h) => h.name);
	const builtinTools = getToolDefinitions(subagentNames, initialModel, loopConfig.subagentModel, sshHostNames);
	const mcpTools = loopConfig.mcpTools ?? [];
	const allTools = [...builtinTools, ...mcpTools];
	const disabledTools = loopConfig.disabledTools;
	// Persona/subagent frontmatter `tools:` allowlists builtins only.
	// LoopConfig wins when set (subagent spawn); otherwise the active persona.
	// MCP tools stay available whenever connected — their names are
	// user/session-specific and must not require listing in the persona file.
	const allowedTools = loopConfig.allowedTools ?? currentPersonaObj?.tools;
	let builtins = disabledTools?.size ? builtinTools.filter((t) => !disabledTools.has(t.function.name)) : builtinTools;
	const mcps = disabledTools?.size ? mcpTools.filter((t) => !disabledTools.has(t.function.name)) : mcpTools;
	if (allowedTools !== undefined) {
		builtins = builtins.filter((t) => matchesToolsAllowlist(t.function.name, allowedTools));
	}
	const tools = [...builtins, ...mcps];
	// Names registered before allowlist/denylist filters — so a call to a
	// real-but-filtered builtin gets "not available", not an unknown-tool hint.
	const knownToolNames = new Set(allTools.map((t) => t.function.name));
	// Names the model is actually allowed to call this turn — used to catch
	// fabricated tool names in executeTool below.
	const advertisedNames = new Set(tools.map((t) => t.function.name));

	// Doom-loop detector: tracks the last DOOM_LOOP_THRESHOLD tool calls
	// (name + serialized args). When the same call appears that many times in
	// a row we refuse to execute it and tell the model to try something else.
	const recentToolCalls: Array<{ name: string; argsKey: string }> = [];

	const openWorkGateConfig: OpenWorkGateConfig = {
		...defaultOpenWorkGateConfig(),
		...loopConfig.openWorkGate,
	};
	// Cap is per outer-loop user prompt; reset when follow-up injects.
	let openWorkGateFires = 0;

	const builtinExecuteTool = createToolExecutor(
		cwd,
		config,
		loopConfig.confirmBash,
		// Gate the executor on the same condition as tool advertisement: a persona
		// without `subagents: true` can neither see nor run `task`, even if the
		// model fabricates a call to it.
		subagentsEnabled
			? {
					model: loopConfig.subagentModel ?? initialModel,
					subagentPrompts: loopConfig.subagentPrompts,
					mcpTools: loopConfig.mcpTools,
					mcpToolIndex,
					confirmBash: loopConfig.confirmBash,
					mainModel: initialModel,
					subagentModel: loopConfig.subagentModel,
					disabledTools: loopConfig.disabledTools,
					planState: loopConfig.planState,
					projectTrusted: loopConfig.projectTrusted,
					runAgentLoop,
				}
			: undefined,
		loopConfig.planState,
		loopConfig.sshHosts,
	);
	const executeTool = (name: string, args: Record<string, unknown>, toolSignal?: AbortSignal): Promise<ToolResult> => {
		// Legacy aliases (e.g. find → glob) before the allowlist / unknown check
		// so old model habits and allowlists keep working against one tool.
		name = normalizeToolName(name);
		// Advertised set is the single source of truth for both definitions and
		// real calls: disabledTools denylist and the builtin tools allowlist.
		// (MCP tools are not subject to the persona/subagent allowlist.)
		if (!advertisedNames.has(name)) {
			if (knownToolNames.has(name) || disabledTools?.has(name)) {
				return Promise.resolve({
					content: `Tool "${name}" is not available in the current mode.`,
					isError: true,
				});
			}
			// Completely unknown name — suggest the closest advertised tool
			// instead of a bare "Unknown tool" the model tends to retry.
			return Promise.resolve(unknownToolResult(name, [...advertisedNames]));
		}
		// Plan mode allows bash for inspection only — enforced here, not by the
		// model's goodwill: pipelines of allowlisted read-only binaries pass,
		// anything that can write (redirects, substitution, unlisted binaries)
		// is refused with the reason. Subagents of a plan-mode parent inherit
		// the same gate via readOnlyBash.
		if (name === "bash" && (loopConfig.planState?.enabled || loopConfig.readOnlyBash)) {
			const verdict = checkReadOnlyCommand(typeof args.command === "string" ? args.command : "");
			if (!verdict.ok) {
				return Promise.resolve({
					content: `Plan mode allows read-only commands only — rejected: ${verdict.reason}. Inspect with ls/cat/grep/find/git log|show|diff|status|blame.`,
					isError: true,
				});
			}
		}
		const mcpTool = mcpToolIndex?.get(name);
		if (mcpTool) return mcpTool.call(args, toolSignal);
		return builtinExecuteTool(name, args, toolSignal);
	};
	const client = createClient(config);
	const steeringQueue = loopConfig.steeringQueue ?? new MessageQueue();
	const followUpQueue = loopConfig.followUpQueue ?? new MessageQueue();

	const currentModel = initialModel;
	// Session-scoped when the caller passes one (so a file referenced in an
	// earlier message keeps its glob rule attached); otherwise per-call.
	const contextFiles = loopConfig.contextFiles ?? [];

	// Build-mode plan snapshot, read ONCE per run: re-reading on every request
	// meant each plan_check rewrote the system prompt mid-run and invalidated
	// the provider's prompt cache for the whole conversation. Mode toggles are
	// rejected while a run is active, so a per-run snapshot loses nothing; the
	// next submit picks up fresh checkbox state from disk.
	const buildPlanSnapshot =
		loopConfig.planState && !loopConfig.planState.enabled ? readActivePlan(loopConfig.planState) : undefined;
	// A session can hold several plans; the mirror carries only the approved
	// one, so name the rest — otherwise the model has no way to know they exist.
	const otherPlanNames =
		buildPlanSnapshot?.path && loopConfig.planState
			? listPlanNames(loopConfig.planState.plansDir).filter((n) => n !== basename(buildPlanSnapshot.path!, ".md"))
			: [];
	// Neutral wording: this line rides along with BOTH mirror variants, and the
	// done-variant explicitly says the plan no longer steers.
	const otherPlansLine =
		otherPlanNames.length > 0
			? `\n\nOther plans in this session: ${otherPlanNames.join(", ")} — use plan_read with a name to view one; none of them steers the work unless approved.`
			: "";

	// Recompute the system prompt from the latest contextFiles/@-mentions and
	// write it into messages[0]. Called before every request so rules that
	// match a file read mid-turn attach on the next request, not only next turn.
	const syncSystemPrompt = (): void => {
		let prompt = systemPrompt;
		if (loopConfig.rebuildSystemPrompt) {
			let userText = "";
			for (let i = messages.length - 1; i >= 0; i--) {
				const m = messages[i]!;
				if (m.role === "user") {
					if (typeof m.content === "string") {
						userText = m.content;
					} else if (Array.isArray(m.content)) {
						const textPart = m.content.find((p: { type?: string }) => p.type === "text") as
							| { type: "text"; text: string }
							| undefined;
						if (textPart) userText = textPart.text;
					}
					break;
				}
			}
			prompt = loopConfig.rebuildSystemPrompt({ userText, contextFiles });
		}
		// Plan mode: prepended AFTER any rebuild — the per-turn rebuild path
		// (always active in the TUI) replaces `prompt` wholesale and would
		// silently drop a block added earlier. The restriction must be the
		// first thing the model sees, persona and rules included.
		if (loopConfig.planState?.enabled) {
			prompt = `${PLAN_MODE_PROMPT}\n\n${prompt}`;
		} else if (loopConfig.readOnlyBash) {
			// Subagent of a plan-mode parent: no plan-mode block (its authoring
			// tools aren't in this toolset), but the bash restriction must be
			// stated or rejections read like malfunctions.
			prompt = `${prompt}\n\n${READONLY_BASH_NOTE}`;
		}
		if (!loopConfig.planState?.enabled && buildPlanSnapshot?.exists && buildPlanSnapshot.path) {
			// Build mode with a plan from this session: append the approved plan
			// (the active one — most recently written) so it keeps steering
			// implementation. Snapshotted per run (see above); re-read on the
			// next run — that's what makes it survive compaction and resume.
			// Appended (not prepended) because it's guidance, not a restriction:
			// the persona keeps its place at the top.
			const { unchecked, checked } = planChecklistState(buildPlanSnapshot.content);
			if (unchecked === 0 && checked > 0) {
				// Fully executed plan: stop steering (and stop paying for the full
				// content every request) — leave a one-line reference instead.
				prompt = `${prompt}\n\n${BUILD_MODE_DONE_PROMPT.replace("{{NAME}}", () => basename(buildPlanSnapshot.path!, ".md")).replace("{{PATH}}", () => buildPlanSnapshot.path!)}${otherPlansLine}`;
			} else {
				prompt = `${prompt}\n\n${BUILD_MODE_PROMPT.replace("{{PLAN}}", () => buildPlanSnapshot.content)}${otherPlansLine}`;
			}
		}
		if (messages.length === 0 || messages[0]?.role !== "system") {
			messages.unshift({ role: "system", content: prompt });
		} else {
			messages[0] = { role: "system", content: prompt };
		}
	};

	// Build an assistant message from partial content and persist it into
	// `messages` so aborted/disconnected turns survive in session history.
	const persistPartialAssistant = (content: string, thinking: string) => {
		if (!content && !thinking) return;
		const assistantMsg: Message = {
			role: "assistant",
			content: content || EMPTY_ASSISTANT_PLACEHOLDER,
		};
		messages.push(assistantMsg);
		onEvent({ type: "assistant_message", content, thinking });
	};

	// Accumulate partial content so aborted/disconnected turns can be
	// persisted into session history (the catch block can't read
	// streamAndCollect's locals after it throws).
	let partialContent = "";
	let partialThinking = "";

	try {
		// Outer loop: continues when follow-up messages arrive after agent would stop
		let overflowCompacted = false;
		outer: while (true) {
			if (signal?.aborted) {
				onEvent({ type: "end", reason: "aborted" });
				break;
			}

			// Sync before compaction so it summarizes against the right system prompt.
			syncSystemPrompt();

			// Compaction
			if (shouldCompact(messages, config, loopConfig.lastPromptTokens)) {
				const result = await compactSessionMessages(
					messages,
					config,
					currentModel,
					signal,
					(attempt, maxAttempts, reason) => onEvent({ type: "retry", attempt, maxAttempts, reason }),
					(usage) => onEvent({ type: "usage", usage }),
					loopConfig.planState?.enabled ? PLAN_COMPACTION_PROMPT : undefined,
					reminderStateFromPlan(loopConfig.planState),
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
					// A fresh user instruction resets the doom-loop window — "run it
					// again" after three identical calls is an explicit go-ahead, not
					// the model stuck in a loop.
					recentToolCalls.length = 0;
				}

				// Re-sync the system prompt against contextFiles that tool calls
				// from the previous inner iteration may have added — this is what
				// makes a glob rule attach immediately after its file is read.
				syncSystemPrompt();

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
				// Accumulate partial content so aborted/disconnected turns can be
				// persisted into session history (the catch block can't read
				// streamAndCollect's locals after it throws).
				try {
					completion = await streamAndCollect(
						client,
						currentModel,
						messages,
						tools,
						config.maxResponseTokens,
						signal,
						(token) => {
							partialContent += token;
							onEvent({ type: "token", text: token });
						},
						(token) => {
							partialThinking += token;
							onEvent({ type: "thinking", text: token });
						},
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
							(token) => {
								partialContent += token;
								onEvent({ type: "token", text: token });
							},
							(token) => {
								partialThinking += token;
								onEvent({ type: "thinking", text: token });
							},
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
							loopConfig.planState?.enabled ? PLAN_COMPACTION_PROMPT : undefined,
							reminderStateFromPlan(loopConfig.planState),
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

				// A mid-stream abort doesn't always reject: undici can end the async
				// iterator cleanly, so streamAndCollect returns a partial result and no
				// exception reaches the outer catch. Without this the partial turn
				// commits as a normal stop and never shows "Aborted" — the symptom of
				// pressing Esc while reasoning streams. `interrupted` (not raw
				// signal.aborted) so a turn that *finished* right before a late Esc is
				// committed normally instead of being mislabeled aborted.
				if (completion.interrupted) {
					persistPartialAssistant(completion.content, completion.thinking);
					onEvent({ type: "end", reason: "aborted" });
					return;
				}

				// Silent truncation: the stream ended mid-response with no finish_reason
				// and no usage, and the user didn't abort — the provider dropped it.
				// Stop and flag it so a cut-off answer isn't mistaken for a clean exit.
				if (completion.disconnected) {
					persistPartialAssistant(completion.content, completion.thinking);
					onEvent({ type: "end", reason: "disconnected" });
					return;
				}

				if (completion.usage) {
					onEvent({ type: "usage", usage: completion.usage, generationMs: completion.generationMs });
				}

				// Check for streaming errors (pi pattern: stopReason check)
				if (completion.finishReason === "error" || completion.finishReason === "aborted") {
					const assistantMsg: Message = {
						role: "assistant",
						content: completion.content || EMPTY_ASSISTANT_PLACEHOLDER,
					};
					messages.push(assistantMsg);
					onEvent({ type: "turn_end", toolResults: [] });
					onEvent({ type: "end", reason: completion.finishReason });
					return;
				}

				// Build assistant message. An assistant turn must carry either
				// content or tool_calls — a turn that produced only reasoning
				// (all output in reasoning_content) would otherwise persist as
				// `content: null` with no tool_calls, a shape providers reject
				// (400) on every following turn once it's in the session.
				const hasToolCalls = Boolean(completion.toolCalls && completion.toolCalls.length > 0);
				const assistantMsg: Message = {
					role: "assistant",
					content: completion.content || (hasToolCalls ? null : EMPTY_ASSISTANT_PLACEHOLDER),
					...(hasToolCalls
						? {
								tool_calls: completion.toolCalls!.map((tc) => ({
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
					const executedToolBatch = await executeToolCalls(
						toolCalls,
						executeTool,
						onEvent,
						signal,
						recentToolCalls,
						DOOM_LOOP_THRESHOLD,
					);
					toolResults.push(...executedToolBatch);
					hasMoreToolCalls = true;

					// Track new tool result messages and extract context files
					for (const r of executedToolBatch) {
						const toolMsg: Message = { role: "tool", tool_call_id: r.id, content: r.result.content };
						messages.push(toolMsg);

						// Propagate subagent usage to the main session, tagged so the UI
						// can attribute it separately from the main agent's own tokens.
						if (r.result.subagentUsage) {
							onEvent({ type: "usage", usage: r.result.subagentUsage, subagent: true });
						}

						// Extract file paths from tool calls for glob matching
						const tc = toolCalls.find((t) => t.id === r.id);
						if (tc) {
							let args: Record<string, unknown>;
							try {
								args = JSON.parse(tc.arguments);
							} catch {
								args = {};
							}
							extractContextFile(tc.name, args, r.result.content, contextFiles, cwd);
						}

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

				// A successful terminal (signal) tool ends the run. The whole batch
				// has already executed and its tool results are in `messages` above —
				// nothing is left dangling — and turn_end fired, which the UI needs to
				// open the mode-transition dialog (it waits for the run to settle).
				// Return rather than break the outer loop: a terminal signal hands
				// control to the user, so the follow-up queue is intentionally not
				// drained. isError is excluded so a failed plan_done (no plan on disk,
				// etc.) lets the model recover instead of stranding the turn.
				if (toolResults.some((r) => TERMINAL_TOOLS.has(r.name) && !r.result.isError)) {
					onEvent({ type: "end", reason: "stop" });
					return;
				}

				// Turn-end open-work gate: content-only stop with open plan steps
				// → inject a system-reminder and keep sampling (capped).
				if (
					(!toolCalls || toolCalls.length === 0) &&
					isOpenWorkGateActive(loopConfig.planState, openWorkGateConfig)
				) {
					const openSteps = collectOpenWorkSteps(loopConfig.planState);
					const decision = evaluateOpenWorkGate({ openSteps });
					if (decision.type === "nudge") {
						if (openWorkGateFires < openWorkGateConfig.maxFiresPerPrompt) {
							openWorkGateFires += 1;
							onEvent({
								type: "open_work_gate",
								fires: openWorkGateFires,
								openSteps: openSteps.length,
							});
							messages.push({ role: "user", content: decision.reminder });
							hasMoreToolCalls = true;
						} else {
							messages.push({
								role: "user",
								content: buildOpenWorkGateExhaustedReminder(openWorkGateConfig.maxFiresPerPrompt),
							});
							onEvent({
								type: "open_work_gate_exhausted",
								openSteps: openSteps.length,
								maxFires: openWorkGateConfig.maxFiresPerPrompt,
							});
						}
					}
				}

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
				// Same as steering: a new user message resets the doom-loop window.
				recentToolCalls.length = 0;
				openWorkGateFires = 0;
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
			persistPartialAssistant(partialContent, partialThinking);
			onEvent({ type: "end", reason: "aborted" });
			return;
		}
		onEvent({ type: "error", message: describeTurnError(error) });
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
	recentToolCalls: Array<{ name: string; argsKey: string }>,
	doomLoopThreshold: number,
): Promise<ToolCallResult[]> {
	const prepared: Array<{ id: string; name: string; args: Record<string, unknown> | null }> = [];
	for (const tc of toolCalls) {
		let args: Record<string, unknown>;
		try {
			args = JSON.parse(tc.arguments);
		} catch {
			// Truncated or malformed arguments (e.g. streaming cut off mid-generation).
			// Don't execute with empty {} — that turns every tool into a confusing error.
			prepared.push({ id: tc.id, name: tc.name, args: null });
			continue;
		}
		prepared.push({ id: tc.id, name: tc.name, args });
	}

	for (const tc of prepared) {
		onEvent({ type: "tool_start", id: tc.id, name: tc.name, args: tc.args ? JSON.stringify(tc.args) : "{}" });
	}

	// Doom-loop detection, decided sequentially in call order BEFORE the
	// parallel execution below. Inside Promise.all every sibling's check runs
	// before any sibling's push lands (the synchronous prefix of each async fn
	// executes first), so checking/pushing per-call in there made a whole batch
	// of identical calls invisible to itself — and pushing after `await
	// executeTool` recorded completion order, not call order, scrambling the
	// "consecutive" window around parallel batches. A blocked call is NOT
	// pushed: repeat attempts stay blocked until a different call breaks the
	// run of identical entries.
	const doomBlocked = new Set<string>();
	for (const tc of prepared) {
		if (tc.args === null) continue;
		const argsKey = JSON.stringify(tc.args);
		const recent = recentToolCalls.slice(-doomLoopThreshold);
		if (recent.length === doomLoopThreshold && recent.every((r) => r.name === tc.name && r.argsKey === argsKey)) {
			doomBlocked.add(tc.id);
			onEvent({ type: "doom_loop", tool: tc.name, attempts: doomLoopThreshold });
		} else {
			recentToolCalls.push({ name: tc.name, argsKey });
		}
	}
	// Keep the sliding window bounded.
	if (recentToolCalls.length > doomLoopThreshold * 2) {
		recentToolCalls.splice(0, recentToolCalls.length - doomLoopThreshold);
	}

	// setMaxListeners(100, signal) is already called once in runLoop — no need
	// to raise it per-batch (and doing so with a small batch would *lower* it).

	const results = await Promise.all(
		prepared.map(async (tc): Promise<ToolCallResult> => {
			if (signal?.aborted) {
				return {
					id: tc.id,
					name: tc.name,
					result: { content: "[ABORTED] Tool execution was cancelled.", isError: true },
				};
			}

			// Truncated/malformed arguments — return an error so the model can retry.
			if (tc.args === null) {
				return {
					id: tc.id,
					name: tc.name,
					result: {
						content: "Tool call arguments were truncated or malformed (invalid JSON). Retry the tool call.",
						isError: true,
					},
				};
			}

			if (doomBlocked.has(tc.id)) {
				return {
					id: tc.id,
					name: tc.name,
					result: {
						content: `Doom loop detected: tool "${tc.name}" was called ${doomLoopThreshold} times consecutively with the same arguments. You MUST try a completely different approach. Do NOT call this tool with the same arguments again.`,
						isError: true,
					},
				};
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

// ============================================================================
// Context file tracking — extracts paths from tool calls for glob matching
// ============================================================================

function extractContextFile(
	_toolName: string,
	args: Record<string, unknown>,
	_result: string,
	contextFiles: string[],
	cwd: string,
): void {
	const rawPath = typeof args.path === "string" ? args.path : undefined;
	if (!rawPath) return;

	// Normalize to relative path from cwd for consistent glob matching
	let relPath: string;
	if (rawPath.startsWith("/")) {
		relPath = rawPath.startsWith(cwd) ? rawPath.slice(cwd.length + 1) : rawPath;
	} else {
		relPath = rawPath;
	}

	if (!contextFiles.includes(relPath)) {
		contextFiles.push(relPath);
	}
}
