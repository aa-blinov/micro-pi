import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AppConfig } from "./config.ts";
import { formatLocalDate } from "./date-rollover-reminder.ts";
import type { Message, Usage } from "./llm.ts";

// ============================================================================
// Session state
// ============================================================================

export interface SessionUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cost: number;
	/** Cumulative tokens served from provider's prompt cache (hits). */
	cacheReadTokens: number;
	/** Cumulative tokens written to provider's prompt cache (new entries). */
	cacheWriteTokens: number;
	/** Cumulative input tokens that were neither cached read nor cached write (full price). */
	uncachedTokens: number;
	/** Cumulative total tokens attributed to subagents — a subset of totalTokens,
	 * tracked separately so the status line can show how much delegation cost. */
	subagentTokens: number;
}

export interface SessionState {
	id: string;
	messages: Message[];
	model: string;
	createdAt: string;
	updatedAt: string;
	/** Cumulative token/cost usage across every turn in this session. */
	usage: SessionUsage;
	/** promptTokens from the most recent API response — the authoritative
	 * measure of current context size. undefined before the first call or
	 * when a session is loaded from disk with no prior API data. */
	lastPromptTokens?: number;
	/**
	 * Absolute path cast was launched from when this session was created —
	 * lets --resume/--continue/`/sessions` switch back into the right project
	 * instead of leaving you wherever you happened to launch from this time.
	 * Optional: sessions saved before per-project grouping existed don't have
	 * one and just stay in the flat legacy directory (see getSessionFileDir).
	 */
	cwd?: string;
	/** Agent mode this session was left in — restored on resume so quitting
	 * mid-planning comes back to plan mode. Unset means "build", the default.
	 * Per-session on purpose: the mode is task state, and storing it globally
	 * leaked plan mode from one project into every other one. */
	mode?: "plan" | "build";
	/** Persona name this thread was last driven by — restored on resume, same
	 * rationale as `mode`: the persona shaped the conversation's reasoning and
	 * tone, so reopening the thread under whatever persona happens to be the
	 * current global one silently swaps the system prompt out from under the
	 * history. Unset on sessions saved before this field existed (resume keeps
	 * the current persona for those). The global settings.persona remains the
	 * default for NEW sessions only. */
	persona?: string;
	/**
	 * Local calendar date (`YYYY-MM-DD`) last announced to the model via the
	 * date-rollover `<system-reminder>`. Used so overnight sessions get a
	 * one-shot notice when the day advances. Optional for older session files.
	 */
	lastAnnouncedLocalDate?: string;
	/**
	 * Provider base URL this session's `model` belongs to. Resume only reuses
	 * the stored model when the current provider matches — a session pinned to
	 * "some-model" from provider A resumed against provider B otherwise sends
	 * every request to a model that doesn't exist there, and providers answer
	 * that with opaque 400s rather than a clean "unknown model". Optional for
	 * sessions saved before this field existed (treated as "unknown provider").
	 */
	providerUrl?: string;
	/**
	 * Reasoning ("thinking") text for assistant messages, keyed by that
	 * message's index in `messages`. The OpenAI wire format (`Message` in
	 * core/llm.ts) has no field for it and it's never sent back to the model,
	 * so it can't live on the message itself — it's only ever handed to
	 * callers as an ephemeral `assistant_message` event (see core/loop.ts).
	 * Only the web UI currently writes/reads this, so a page reload or
	 * session switch can still show a turn's reasoning instead of silently
	 * dropping it; the TUI continues to show reasoning live-only, matching
	 * its prior behavior on resume.
	 */
	reasoning?: Record<number, string>;
	/**
	 * Display title for this thread — defaults to a truncation of the first
	 * user message (set once, the first time one arrives) and can be
	 * overridden by an explicit rename. Optional: sessions saved before this
	 * field existed, or ones with no messages yet, fall back to showing the
	 * persona name instead. Currently only read/written by the web UI.
	 */
	title?: string;
	/** Pinned to the top of the web UI's session list. Web-only, like `title`. */
	pinned?: boolean;
}

/** Fold one turn's usage into the session's running totals. When `opts.subagent`
 * is set, the tokens are also accumulated into `subagentTokens` (still part of the
 * grand total) and the context-size tracker is left untouched — a subagent's
 * prompt size says nothing about the main session's context. */
const safe = (v: number | undefined) => Math.max(0, v ?? 0);

export function addUsage(session: SessionState, usage: Usage, opts?: { subagent?: boolean }): void {
	session.usage.promptTokens += safe(usage.promptTokens);
	session.usage.completionTokens += safe(usage.completionTokens);
	session.usage.totalTokens += safe(usage.totalTokens);
	if (usage.cost !== undefined) session.usage.cost += safe(usage.cost);
	if (usage.cacheReadTokens !== undefined) session.usage.cacheReadTokens += safe(usage.cacheReadTokens);
	if (usage.cacheWriteTokens !== undefined) session.usage.cacheWriteTokens += safe(usage.cacheWriteTokens);
	if (usage.uncachedTokens !== undefined) session.usage.uncachedTokens += safe(usage.uncachedTokens);
	if (opts?.subagent) {
		session.usage.subagentTokens += usage.totalTokens;
		return;
	}
	// Track the latest promptTokens as the authoritative context size.
	session.lastPromptTokens = usage.promptTokens;
}

// ============================================================================
// Token estimation
// ============================================================================

export function estimateTokens(messages: Message[]): number {
	// Rough estimate: ~3.8 characters per token. Walk the structure directly
	// to avoid materializing a huge JSON string via JSON.stringify.
	let chars = 0;
	for (const m of messages) {
		chars += 20; // JSON overhead per message (braces, role key, commas)
		if (typeof m.content === "string") {
			chars += m.content.length;
		} else if (Array.isArray(m.content)) {
			for (const part of m.content) {
				if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") {
					chars += part.text.length;
				} else {
					chars += 50; // structured content estimate
				}
			}
		}
		if ("tool_calls" in m && m.tool_calls) {
			for (const tc of m.tool_calls) {
				if (tc.type === "function") {
					chars += tc.function.name.length + tc.function.arguments.length + 30;
				}
			}
		}
		if ("name" in m && typeof m.name === "string") chars += m.name.length;
		if ("refusal" in m && typeof m.refusal === "string") chars += m.refusal.length;
		if (m.role === "tool" && "tool_call_id" in m && typeof m.tool_call_id === "string")
			chars += m.tool_call_id.length;
	}
	return Math.ceil(chars / 3.8);
}

// ============================================================================
// Compaction
// ============================================================================

interface CompactionSummary {
	summary: string;
	tokensBefore: number;
	messagesCompacted: number;
}

/**
 * Check if compaction is needed.
 *
 * Uses the API-reported promptTokens from the last call (authoritative).
 * Returns false when no API data is available (e.g. before the first turn
 * or session loaded from disk) — matching opencode's approach where missing
 * usage simply means no compaction trigger; the provider will error with
 * "context exceeded" if the conversation grows too large.
 */
export function shouldCompact(_messages: Message[], config: AppConfig, lastPromptTokens?: number): boolean {
	if (lastPromptTokens === undefined) return false;
	const budget = config.contextWindow - config.maxResponseTokens;
	return lastPromptTokens > budget * config.compactionThreshold;
}

/**
 * Move a proposed cut index to the start of the nearest turn (the `user`
 * message that began it). Two things go wrong without this:
 *
 * 1. A `tool` result is only valid immediately after the `assistant`
 *    message whose `tool_calls` produced it — landing the cut between them
 *    sends the provider a message list it will reject outright (a tool
 *    result with no matching tool_calls in the same request).
 * 2. Even a cut that avoids (1) but lands mid-turn (e.g. between two
 *    tool-call rounds within the same turn) stashes half a turn's tool
 *    calls in "recent" with no user message explaining why they happened.
 *
 * Snapping to the turn boundary fixes both: a turn's messages always travel
 * together. Searches forward first — like pi's findCutPoint, which snaps to
 * the nearest valid boundary *at or after* where it stopped accumulating
 * "recent" tokens — so a mid-turn target extends "recent" rather than
 * shrinking it below what was asked for. Falls back to searching backward
 * only when there's no turn boundary ahead at all (the target is already
 * inside the last open turn); if that also finds nothing, 0 means "nothing
 * safely compactable yet", which compactMessages already treats as a no-op.
 * Simplified from pi's turn tree + separate turn-prefix summarization,
 * which we don't need since our split is a rough 60/40 index cut rather
 * than a strict token budget — there's already slack either side of it.
 */
function safeCutIndex(messages: Message[], idx: number): number {
	const target = Math.max(0, Math.min(idx, messages.length));

	for (let i = target; i < messages.length; i++) {
		if (messages[i]?.role === "user") return i;
	}
	for (let i = target; i > 0; i--) {
		if (messages[i]?.role === "user") return i;
	}
	return 0;
}

// ============================================================================
// File operations tracking (for compaction summaries)
// ============================================================================

/**
 * Pull file paths touched by read/write/edit tool calls out of the messages
 * being summarized away, bucketed into read-only vs. modified, seeded with
 * whatever a previous compaction round already found (see
 * parseFileTagsFromSummary) so paths touched several compactions ago don't
 * fall off as each round only ever looks at its own slice of history. The
 * compaction prompt already asks the summarizer to "keep all file paths",
 * but that's a request, not a guarantee — this extracts them deterministically
 * from the tool_calls themselves and appends them to the summary, so a path
 * surviving compaction doesn't depend on the summarizer remembering it.
 */
function extractFileOps(
	messages: Message[],
	previousReadFiles: string[] = [],
	previousModifiedFiles: string[] = [],
): { readFiles: string[]; modifiedFiles: string[] } {
	const read = new Set(previousReadFiles);
	const written = new Set<string>();
	const edited = new Set(previousModifiedFiles);

	for (const m of messages) {
		if (m.role !== "assistant" || !("tool_calls" in m) || !m.tool_calls) continue;
		for (const tc of m.tool_calls) {
			if (tc.type !== "function") continue;
			let args: Record<string, unknown>;
			try {
				args = JSON.parse(tc.function.arguments);
			} catch {
				continue;
			}
			const path = typeof args.path === "string" ? args.path : undefined;
			if (!path) continue;
			if (tc.function.name === "read") read.add(path);
			else if (tc.function.name === "write") written.add(path);
			else if (tc.function.name === "edit") edited.add(path);
		}
	}

	const modified = new Set([...written, ...edited]);
	const readFiles = [...read].filter((f) => !modified.has(f)).sort();
	return { readFiles, modifiedFiles: [...modified].sort() };
}

function formatFileOps(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

/** Pull the `<read-files>`/`<modified-files>` tags back out of a previous summary. */
function parseFileTagsFromSummary(text: string): { readFiles: string[]; modifiedFiles: string[] } {
	const readMatch = text.match(/<read-files>\n([\s\S]*?)\n<\/read-files>/);
	const modifiedMatch = text.match(/<modified-files>\n([\s\S]*?)\n<\/modified-files>/);
	return {
		readFiles: readMatch ? readMatch[1]!.split("\n").filter(Boolean) : [],
		modifiedFiles: modifiedMatch ? modifiedMatch[1]!.split("\n").filter(Boolean) : [],
	};
}

/** Public alias for post-compact reminder assembly. */
export function fileTagsFromCompactionSummary(text: string): { readFiles: string[]; modifiedFiles: string[] } {
	return parseFileTagsFromSummary(text);
}

const COMPACTION_MARKER_PREFIX = "[Compacted context";

/**
 * Split a message array's system messages into the persona/instructions
 * ones and (if present) an existing compaction-summary marker. Repeat
 * compactions thread that summary back in as `previousSummary` so the
 * result is one running summary that gets updated, not a stack of markers
 * from every compaction round this session has ever hit.
 */
function extractPreviousCompaction(systemMessages: Message[]): {
	personaMessages: Message[];
	previousSummary?: string;
} {
	const personaMessages: Message[] = [];
	let previousSummary: string | undefined;

	for (const m of systemMessages) {
		const content = typeof m.content === "string" ? m.content : "";
		if (previousSummary === undefined && content.startsWith(COMPACTION_MARKER_PREFIX)) {
			const newlineIdx = content.indexOf("\n");
			previousSummary = newlineIdx === -1 ? "" : content.slice(newlineIdx + 1);
		} else {
			personaMessages.push(m);
		}
	}

	return { personaMessages, previousSummary };
}

const TOOL_RESULT_MAX_CHARS = 500;

/** One tool call as `name(arg=val, ...)`, truncating long argument values. */
function formatToolCall(name: string, argsJson: string): string {
	let args: Record<string, unknown>;
	try {
		args = JSON.parse(argsJson);
	} catch {
		return `${name}(${argsJson.slice(0, 200)})`;
	}
	const argsStr = Object.entries(args)
		.map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 200) : JSON.stringify(v)}`)
		.join(", ");
	return `${name}(${argsStr})`;
}

/**
 * Render one message as a line of text for the summarization prompt. The
 * OpenAI-shaped Message (content: string | null, tool_calls as a sibling
 * field) means an assistant turn that's purely a tool call has null content
 * — without surfacing tool_calls explicitly here, that turn would vanish
 * from the summarizer's input entirely, which for a coding agent (mostly
 * tool calls) throws away almost everything that happened.
 */
function formatMessageForSummary(m: Message): string {
	if (m.role === "assistant") {
		const parts: string[] = [];
		if (typeof m.content === "string" && m.content) parts.push(m.content);
		if ("tool_calls" in m && m.tool_calls) {
			for (const tc of m.tool_calls) {
				if (tc.type === "function")
					parts.push(`[tool call: ${formatToolCall(tc.function.name, tc.function.arguments)}]`);
			}
		}
		return `assistant: ${parts.join(" ") || "(no content)"}`;
	}
	if (m.role === "tool") return `tool (${m.tool_call_id}): ${String(m.content).slice(0, TOOL_RESULT_MAX_CHARS)}`;
	if (typeof m.content === "string") return `${m.role}: ${m.content.slice(0, 500)}`;
	return `${m.role}: [structured content]`;
}

/**
 * LLM-based compaction: summarize old messages, keep recent ones.
 *
 * summarizeFn's second argument is the previous compaction's summary, when
 * this isn't the first time this session has been compacted — pass it
 * through to the model as update-in-place context (matching pi's
 * UPDATE_SUMMARIZATION_PROMPT) rather than starting from scratch each time,
 * so the running summary keeps improving instead of each round only
 * knowing about its own slice of history.
 */
export async function compactMessages(
	messages: Message[],
	summarizeFn: (text: string, previousSummary?: string) => Promise<string>,
	_config: AppConfig,
): Promise<{ messages: Message[]; summary: CompactionSummary }> {
	const tokensBefore = estimateTokens(messages);

	// Split: 60% old, 40% recent, snapped back to a safe boundary (see
	// safeCutIndex) so "recent" never opens on an orphaned tool result.
	const { personaMessages: system, previousSummary } = extractPreviousCompaction(
		messages.filter((m) => m.role === "system"),
	);
	const nonSystem = messages.filter((m) => m.role !== "system");
	const splitIdx = safeCutIndex(nonSystem, Math.floor(nonSystem.length * 0.6));
	const old = nonSystem.slice(0, splitIdx);
	const recent = nonSystem.slice(splitIdx);

	// No safe cut point below the target split (a degenerate history —
	// e.g. one long unbroken tool-call chain with nothing before it) means
	// there's nothing to compact yet. Skip the LLM call rather than
	// "summarizing" zero messages and injecting a pointless marker.
	if (old.length === 0) {
		return { messages, summary: { summary: "", tokensBefore, messagesCompacted: 0 } };
	}

	// File tags are appended to the LLM's output below, not baked into its
	// input — extraction is deterministic from the tool_calls themselves,
	// so there's no reason to hope the model reproduces them verbatim (it
	// wasn't even asked to; the structured summary template has no tags
	// section). Matches pi: formatFileOperations is appended after the
	// summarization call, not folded into the conversation text.
	const previousFileTags = previousSummary ? parseFileTagsFromSummary(previousSummary) : undefined;
	const { readFiles, modifiedFiles } = extractFileOps(
		old,
		previousFileTags?.readFiles,
		previousFileTags?.modifiedFiles,
	);
	const oldText = old.map(formatMessageForSummary).join("\n");

	const summary = (await summarizeFn(oldText, previousSummary)) + formatFileOps(readFiles, modifiedFiles);

	const compacted: Message[] = [
		...system,
		{
			role: "system",
			content: `${COMPACTION_MARKER_PREFIX} — ${old.length} messages summarized]\n${summary}`,
		},
		...recent,
	];

	return {
		messages: compacted,
		summary: {
			summary,
			tokensBefore,
			messagesCompacted: old.length,
		},
	};
}

// ============================================================================
// Session persistence (JSONL)
// ============================================================================

const SESSIONS_DIR = ".cast/sessions";

/** `~/.cast/sessions` — the root everything else lives under. */
function getSessionsRootDir(): string {
	const dir = join(homedir(), SESSIONS_DIR);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Encode an absolute cwd into a directory-safe name, matching pi's own
 * `--<cwd with /, \, : replaced by ->--` scheme — no reason to invent a
 * different one, and it keeps the two tools' session trees legible side by
 * side if someone has both installed.
 */
function encodeCwdForSessionDir(cwd: string): string {
	return `--${resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
}

/** `~/.cast/sessions/<encoded-cwd>/` path, without creating it. */
function getProjectSessionDirPath(cwd: string): string {
	return join(getSessionsRootDir(), encodeCwdForSessionDir(cwd));
}

/** Same, but ensures the directory exists — for callers about to write into it. */
function getProjectSessionDir(cwd: string): string {
	const dir = getProjectSessionDirPath(cwd);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

export function saveSession(session: SessionState): void {
	// updatedAt previously only moved when appendMessage ran (i.e. when the
	// user's own message was added at the start of a turn) — every mutation
	// made during the turn itself (assistant replies, tool results,
	// compaction) left it stale, so the session picker's "last updated" time
	// and getMostRecentSession() sort order reflected turn-start, not
	// turn-end. saveSession is the one place every mutation path funnels
	// through before hitting disk, so bump it here instead of relying on
	// every caller to remember to do it themselves.
	session.updatedAt = new Date().toISOString();
	// Sessions from before per-project grouping existed have no cwd — leave
	// them where they are (flat, at the root) rather than inventing one.
	const dir = session.cwd ? getProjectSessionDir(session.cwd) : getSessionsRootDir();
	const filePath = join(dir, `${session.id}.json`);
	writeFileAtomic(filePath, JSON.stringify(session));
}

/**
 * Write to a temp file in the same directory, then rename over the target.
 * rename is atomic within a filesystem, so a reader (or a crash) never sees a
 * half-written session file — the exact truncation that readSessionFile has to
 * defend against otherwise.
 */
function writeFileAtomic(filePath: string, data: string): void {
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	writeFileSync(tmpPath, data, "utf-8");
	renameSync(tmpPath, filePath);
}

/** Sessions saved before `usage` existed don't have it on disk — default it in.
 * Also backfills fields added after `usage` itself (e.g. `subagentTokens`). */
function withUsageDefault(session: SessionState): SessionState {
	const usage = session.usage ?? {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cost: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		uncachedTokens: 0,
		subagentTokens: 0,
	};
	return { ...session, usage: { ...usage, subagentTokens: usage.subagentTokens ?? 0 } };
}

/**
 * Find a session's file by id without needing to know which project it
 * belongs to — checks the flat legacy root first, then every project
 * subdirectory. IDs are checked for uniqueness within a project dir at
 * creation time (see createSession), not globally, but a cross-project
 * collision is astronomically unlikely on top of an already-rare one.
 */
function findSessionFilePath(id: string): string | null {
	const root = getSessionsRootDir();
	const legacyPath = join(root, `${id}.json`);
	if (existsSync(legacyPath)) return legacyPath;

	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const candidate = join(root, entry.name, `${id}.json`);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Read and parse a session file, returning null if it's missing, truncated,
 * or not valid JSON — a session file can be left half-written if the process
 * dies mid-save, and one bad file shouldn't take down the whole listing.
 */
function readSessionFile(filePath: string): SessionState | null {
	try {
		const session = withUsageDefault(JSON.parse(readFileSync(filePath, "utf-8")));
		normalizeStoredMessages(session);
		return session;
	} catch {
		return null;
	}
}

/**
 * Undo provider-specific damage persisted by older builds: applyCacheControl
 * used to mutate the live message objects (string content → [{type: "text",
 * text, cache_control}]) and saveSession wrote that request-only shape to
 * disk. A provider whose chat template expects plain string content then
 * 400s on every resumed session ("Can only get item pairs from a mapping").
 * Flatten all-text part arrays back to strings and drop cache_control
 * everywhere; genuinely multimodal arrays (image parts) are kept as arrays,
 * only stripped of cache_control.
 */
function normalizeStoredMessages(session: SessionState): void {
	for (const message of session.messages as Array<{ content?: unknown }>) {
		const content = message.content;
		if (!Array.isArray(content)) continue;
		const parts = content.map((p) => {
			if (p && typeof p === "object" && "cache_control" in p) {
				const { cache_control: _dropped, ...rest } = p as Record<string, unknown>;
				return rest;
			}
			return p;
		});
		const allText = parts.every(
			(p) =>
				p &&
				typeof p === "object" &&
				(p as { type?: unknown }).type === "text" &&
				typeof (p as { text?: unknown }).text === "string",
		);
		message.content = allText ? parts.map((p) => (p as { text: string }).text).join("") : parts;
	}
}

export function loadSession(id: string): SessionState | null {
	const filePath = findSessionFilePath(id);
	if (!filePath) return null;
	return readSessionFile(filePath);
}

/** Delete a saved session's file from disk. Returns false if it wasn't found. */
export function deleteSession(id: string): boolean {
	const filePath = findSessionFilePath(id);
	if (!filePath) return false;
	unlinkSync(filePath);
	return true;
}

/** Every session file path: project subdirectories plus legacy flat files. */
function listSessionFilePaths(): string[] {
	const root = getSessionsRootDir();
	const paths: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(".json")) {
			// Legacy flat session file, pre-project-grouping. The summary index
			// lives at the root too and is NOT a session.
			if (entry.name === INDEX_FILE_NAME) continue;
			paths.push(join(root, entry.name));
			continue;
		}
		if (!entry.isDirectory()) continue;
		const projectDir = join(root, entry.name);
		for (const f of readdirSync(projectDir).filter((name) => name.endsWith(".json"))) {
			paths.push(join(projectDir, f));
		}
	}
	return paths;
}

export function listSessions(): SessionState[] {
	const sessions: SessionState[] = [];
	for (const filePath of listSessionFilePaths()) {
		const session = readSessionFile(filePath);
		if (session) sessions.push(session);
	}
	return sessions;
}

// ============================================================================
// Session summaries — the lightweight view the session picker runs on.
//
// Parsing every session file just to render a list row (and again on every
// delete-menu round trip) reads tens of MB of JSON that is immediately thrown
// away — only a few hundred bytes per session survive into the UI. The
// summaries are cached in a single index file next to the sessions and
// validated per-entry against each file's mtime: a stale, missing, or corrupt
// index never returns wrong data, it just costs one re-parse of the affected
// files. The index is a cache, not a source of truth — deleting it merely
// makes the next listing rebuild it (the old full-parse cost, once).
// ============================================================================

const INDEX_FILE_NAME = "index.json";
const INDEX_VERSION = 2;

export interface SessionSummary {
	id: string;
	cwd?: string;
	persona?: string;
	model?: string;
	title?: string;
	pinned?: boolean;
	createdAt?: string;
	updatedAt: string;
	msgCount: number;
	/** First user message text — the list row's description. */
	firstUserMessage: string;
	/** Full-thread user/assistant text for the fuzzy filter. */
	haystack: string;
}

interface IndexEntry extends SessionSummary {
	mtimeMs: number;
}

interface SessionIndex {
	version: number;
	/** Keyed by absolute file path — ids are unique per directory, paths globally. */
	entries: Record<string, IndexEntry>;
}

function indexFilePath(): string {
	return join(getSessionsRootDir(), INDEX_FILE_NAME);
}

/** Tolerant read: missing, corrupt, or version-mismatched index → empty. */
function readIndex(): SessionIndex {
	try {
		const parsed = JSON.parse(readFileSync(indexFilePath(), "utf-8")) as SessionIndex;
		if (parsed?.version !== INDEX_VERSION || typeof parsed.entries !== "object" || parsed.entries === null) {
			return { version: INDEX_VERSION, entries: {} };
		}
		return parsed;
	} catch {
		return { version: INDEX_VERSION, entries: {} };
	}
}

/** Text of a message for indexing: plain string or first text part. */
function messageText(m: { content?: unknown }): string {
	const content = m.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const part = content.find((p: { type?: string }) => p.type === "text") as { text?: string } | undefined;
		return part?.text ?? "";
	}
	return "";
}

/** First user message, newline-flattened — the picker row's description. */
export function getFirstUserMessage(session: SessionState): string {
	const msg = session.messages.find((m) => m.role === "user");
	return msg ? messageText(msg).replace(/\n/g, " ").trim() : "";
}

/**
 * Fuzzy-search haystack for a session: cwd + id + every user/assistant
 * message text in the thread. System and tool messages are skipped — the
 * system prompt alone is tens of KB of boilerplate shared by every session,
 * and tool output is the bulk of a session's bytes; what's left (the actual
 * dialog) measures ~1MB across hundreds of real sessions.
 */
export function getSearchHaystack(session: SessionState): string {
	const parts: string[] = [];
	if (session.cwd) parts.push(session.cwd);
	parts.push(session.id);
	for (const m of session.messages) {
		if (m.role !== "user" && m.role !== "assistant") continue;
		const text = messageText(m).replace(/\s+/g, " ").trim();
		if (text) parts.push(text);
	}
	return parts.join("\n");
}

function summarizeSession(session: SessionState): SessionSummary {
	return {
		id: session.id,
		...(session.cwd ? { cwd: session.cwd } : {}),
		...(session.persona ? { persona: session.persona } : {}),
		...(session.model ? { model: session.model } : {}),
		...(session.title ? { title: session.title } : {}),
		...(session.pinned ? { pinned: session.pinned } : {}),
		...(session.createdAt ? { createdAt: session.createdAt } : {}),
		updatedAt: session.updatedAt,
		msgCount: session.messages.length,
		firstUserMessage: getFirstUserMessage(session),
		haystack: getSearchHaystack(session),
	};
}

/**
 * Summaries of every saved session, served from the mtime-validated index.
 * Only files that are new or changed since the index was written get parsed;
 * entries for deleted files are pruned. The healed index is persisted (atomic
 * rename, same as session files) whenever anything changed, so concurrent
 * cast instances at worst overwrite each other with equally valid states.
 */
export function listSessionSummaries(): SessionSummary[] {
	const index = readIndex();
	const summaries: SessionSummary[] = [];
	const seen = new Set<string>();
	let dirty = false;

	for (const path of listSessionFilePaths()) {
		let mtimeMs: number;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			continue; // deleted between readdir and stat
		}
		seen.add(path);
		const cached = index.entries[path];
		if (cached && cached.mtimeMs === mtimeMs) {
			summaries.push(cached);
			continue;
		}
		const session = readSessionFile(path);
		if (!session) continue; // corrupt file — don't index, don't list
		const entry: IndexEntry = { ...summarizeSession(session), mtimeMs };
		index.entries[path] = entry;
		summaries.push(entry);
		dirty = true;
	}

	for (const path of Object.keys(index.entries)) {
		if (!seen.has(path)) {
			delete index.entries[path];
			dirty = true;
		}
	}

	if (dirty) {
		try {
			writeFileAtomic(indexFilePath(), JSON.stringify(index));
		} catch {
			// Read-only FS or similar — the index is only a cache; listing
			// still returned correct data, the next call just re-parses again.
		}
	}
	return summaries;
}

/**
 * Most recently updated session, or null if none are saved yet. Sorts by file
 * mtime and parses only the newest file instead of parsing every session —
 * `cast -c` needs exactly one session, and the full-parse version was paying
 * tens of MB of JSON for it. mtime tracks updatedAt because saveSession is
 * the only writer. Falls back to the next-newest file when the newest one is
 * corrupt (half-written save), matching readSessionFile's tolerance.
 */
export function getMostRecentSession(): SessionState | null {
	const stamped: Array<{ path: string; mtimeMs: number }> = [];
	for (const path of listSessionFilePaths()) {
		try {
			stamped.push({ path, mtimeMs: statSync(path).mtimeMs });
		} catch {
			// Deleted between readdir and stat — skip.
		}
	}
	stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
	for (const { path } of stamped) {
		const session = readSessionFile(path);
		if (session) return session;
	}
	return null;
}

function generateSessionId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function createSession(model: string, cwd: string): SessionState {
	const now = new Date().toISOString();
	// Path only, no mkdir — the session may never actually get saved (e.g.
	// the user immediately resumes/switches to a different one), and this
	// used to leave an empty directory behind for every cwd cast was ever
	// launched from, whether or not anything was saved there. existsSync
	// against a not-yet-created directory just returns false, so the
	// collision check below works fine without it existing yet.
	const dir = getProjectSessionDirPath(cwd);
	// The timestamp+random scheme is astronomically unlikely to collide, but
	// "unlikely" isn't "impossible" and saveSession() would silently overwrite
	// an existing session's file with no warning. Regenerating on an existsSync
	// hit is nearly free — this loop virtually never runs more than once.
	let id = generateSessionId();
	while (existsSync(join(dir, `${id}.json`))) {
		id = generateSessionId();
	}
	return {
		id,
		messages: [],
		model,
		createdAt: now,
		updatedAt: now,
		usage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cost: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			uncachedTokens: 0,
			subagentTokens: 0,
		},
		cwd: resolve(cwd),
		lastAnnouncedLocalDate: formatLocalDate(),
	};
}

export function appendMessage(session: SessionState, message: Message): void {
	session.messages.push(message);
}
