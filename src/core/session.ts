import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppConfig } from "./config.ts";
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
}

/** Fold one turn's usage into the session's running totals. */
export function addUsage(session: SessionState, usage: Usage): void {
	session.usage.promptTokens += usage.promptTokens;
	session.usage.completionTokens += usage.completionTokens;
	session.usage.totalTokens += usage.totalTokens;
	if (usage.cost) session.usage.cost += usage.cost;
	if (usage.cacheReadTokens) session.usage.cacheReadTokens += usage.cacheReadTokens;
	if (usage.cacheWriteTokens) session.usage.cacheWriteTokens += usage.cacheWriteTokens;
	if (usage.uncachedTokens) session.usage.uncachedTokens += usage.uncachedTokens;
	// Track the latest promptTokens as the authoritative context size.
	session.lastPromptTokens = usage.promptTokens;
}

function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/**
 * Table of lines for a session picker (/sessions, --resume): number, id,
 * when, project, model, message count, token in/out + cost, and a preview of
 * the first user message. Column widths are computed across the whole batch
 * so everything actually lines up — a fixed per-field separator doesn't work
 * once id/model/usage lengths vary row to row. Shared between select.ts's
 * startup picker and index.ts's mid-session /sessions so the two don't
 * drift out of sync.
 */
export function formatSessionList(sessions: SessionState[], currentId?: string): string[] {
	const rows = sessions.map((s, i) => {
		const num = `${i + 1}.`;
		const marker = s.id === currentId ? " (current)" : "";
		const id = `${s.id}${marker}`;
		const when = s.updatedAt.slice(0, 16).replace("T", " ");
		// Basename only, not the full path — the picker is a scannable list,
		// not a filesystem browser. "-" for sessions saved before cwd was
		// tracked (see the SessionState.cwd doc comment).
		const project = s.cwd ? (s.cwd.split(/[/\\]/).filter(Boolean).pop() ?? s.cwd) : "-";
		const costSuffix = s.usage.cost ? `, $${s.usage.cost.toFixed(4)}` : "";
		const usage = `(${s.messages.length} msgs, ${formatTokenCount(s.usage.promptTokens)} in / ${formatTokenCount(s.usage.completionTokens)} out${costSuffix})`;
		const firstUserMsg = s.messages.find((m) => m.role === "user");
		const preview = firstUserMsg && typeof firstUserMsg.content === "string" ? firstUserMsg.content.slice(0, 50) : "";
		return { num, id, when, project, model: s.model, usage, preview };
	});

	const width = (get: (r: (typeof rows)[number]) => string) => {
		let max = 0;
		for (const r of rows) {
			const len = get(r).length;
			if (len > max) max = len;
		}
		return max;
	};
	const numW = width((r) => r.num);
	const idW = width((r) => r.id);
	const whenW = width((r) => r.when);
	const projectW = width((r) => r.project);
	const modelW = width((r) => r.model);
	const usageW = width((r) => r.usage);

	return rows.map(
		(r) =>
			`  ${r.num.padStart(numW)} ${r.id.padEnd(idW)}  ${r.when.padEnd(whenW)}  ${r.project.padEnd(projectW)}  ${r.model.padEnd(modelW)}  ${r.usage.padEnd(usageW)}  ${r.preview}`,
	);
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

/**
 * Simple pruning: keep system + first user + last N messages.
 * This is the fallback when no LLM summarization is available.
 */
export function pruneToFit(messages: Message[], maxTokens: number): Message[] {
	if (estimateTokens(messages) <= maxTokens) return messages;

	const system = messages.filter((m) => m.role === "system");
	const nonSystem = messages.filter((m) => m.role !== "system");

	// Keep first user message and the last ~20 messages, snapped back to a
	// safe boundary so "recent" never opens on an orphaned tool result.
	const firstUser = nonSystem.find((m) => m.role === "user");
	const cutIndex = safeCutIndex(nonSystem, Math.max(0, nonSystem.length - 20));
	const recent = nonSystem.slice(cutIndex);

	const pruned = [...system, ...(firstUser && !recent.includes(firstUser) ? [firstUser] : []), ...recent];

	return pruned;
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
export function getSessionsRootDir(): string {
	const dir = join(process.env.HOME ?? ".", SESSIONS_DIR);
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
	writeFileSync(filePath, JSON.stringify(session), "utf-8");
}

/** Sessions saved before `usage` existed don't have it on disk — default it in. */
function withUsageDefault(session: SessionState): SessionState {
	return {
		...session,
		usage: session.usage ?? {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cost: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			uncachedTokens: 0,
		},
	};
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

export function loadSession(id: string): SessionState | null {
	const filePath = findSessionFilePath(id);
	if (!filePath) return null;
	return withUsageDefault(JSON.parse(readFileSync(filePath, "utf-8")));
}

/** Delete a saved session's file from disk. Returns false if it wasn't found. */
export function deleteSession(id: string): boolean {
	const filePath = findSessionFilePath(id);
	if (!filePath) return false;
	unlinkSync(filePath);
	return true;
}

export function listSessions(): SessionState[] {
	const root = getSessionsRootDir();
	const sessions: SessionState[] = [];

	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(".json")) {
			// Legacy flat file, pre-project-grouping.
			sessions.push(withUsageDefault(JSON.parse(readFileSync(join(root, entry.name), "utf-8"))));
			continue;
		}
		if (!entry.isDirectory()) continue;
		const projectDir = join(root, entry.name);
		for (const f of readdirSync(projectDir).filter((name) => name.endsWith(".json"))) {
			sessions.push(withUsageDefault(JSON.parse(readFileSync(join(projectDir, f), "utf-8"))));
		}
	}

	return sessions;
}

/** Most recently updated session, or null if none are saved yet. */
export function getMostRecentSession(): SessionState | null {
	const sessions = listSessions();
	if (sessions.length === 0) return null;
	return sessions.reduce((latest, s) => (s.updatedAt > latest.updatedAt ? s : latest));
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
		},
		cwd: resolve(cwd),
	};
}

export function appendMessage(session: SessionState, message: Message): void {
	session.messages.push(message);
}
