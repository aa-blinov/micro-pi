import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../src/core/llm.ts";
import {
	compactMessages,
	createSession,
	deleteSession,
	estimateTokens,
	formatSessionList,
	getMostRecentSession,
	listSessions,
	loadSession,
	pruneToFit,
	saveSession,
	shouldCompact,
} from "../src/core/session.ts";

// ============================================================================
// estimateTokens
// ============================================================================

describe("estimateTokens", () => {
	it("returns ~0 for empty messages", () => {
		expect(estimateTokens([])).toBeLessThan(5);
	});

	it("estimates tokens for a single message", () => {
		const messages: Message[] = [{ role: "user", content: "Hello, how are you?" }];
		const tokens = estimateTokens(messages);
		expect(tokens).toBeGreaterThan(0);
		expect(tokens).toBeLessThan(100);
	});

	it("scales with message count", () => {
		const one: Message[] = [{ role: "user", content: "Hello" }];
		const ten: Message[] = Array.from({ length: 10 }, () => ({ role: "user", content: "Hello" }));
		expect(estimateTokens(ten)).toBeGreaterThan(estimateTokens(one));
	});
});

// ============================================================================
// shouldCompact
// ============================================================================

describe("shouldCompact", () => {
	const config = {
		contextWindow: 1000,
		maxResponseTokens: 100,
		compactionThreshold: 0.75,
	};

	it("returns false when under threshold", () => {
		const messages: Message[] = [{ role: "user", content: "Hello" }];
		expect(shouldCompact(messages, config as any)).toBe(false);
	});

	it("returns true when over threshold", () => {
		const messages: Message[] = [{ role: "user", content: "Hello" }];
		// shouldCompact now uses API-reported promptTokens, not message estimation.
		expect(shouldCompact(messages, config as any, 800)).toBe(true);
	});

	it("returns false when no API usage data", () => {
		const messages: Message[] = [{ role: "user", content: "Hello" }];
		expect(shouldCompact(messages, config as any)).toBe(false);
	});
});

// ============================================================================
// pruneToFit
// ============================================================================

describe("pruneToFit", () => {
	it("returns messages unchanged when under limit", () => {
		const messages: Message[] = [
			{ role: "system", content: "You are helpful." },
			{ role: "user", content: "Hello" },
		];
		const result = pruneToFit(messages, 100_000);
		expect(result).toEqual(messages);
	});

	it("keeps system messages and recent messages", () => {
		const messages: Message[] = [
			{ role: "system", content: "System prompt" },
			{ role: "user", content: "First message" },
			{ role: "assistant", content: "First response" },
			...Array.from({ length: 30 }, (_, i) => [
				{ role: "user" as const, content: `Message ${i}` },
				{ role: "assistant" as const, content: `Response ${i}` },
			]).flat(),
		];

		const result = pruneToFit(messages, 100);
		// Should keep system + recent 20
		expect(result.length).toBeLessThan(messages.length);
		expect(result[0]?.role).toBe("system");
	});

	it("preserves first user message when possible", () => {
		const messages: Message[] = [
			{ role: "system", content: "System" },
			{ role: "user", content: "First user message" },
			{ role: "assistant", content: "First response" },
			...Array.from({ length: 30 }, (_, i) => [
				{ role: "user" as const, content: `Msg ${i}` },
				{ role: "assistant" as const, content: `Resp ${i}` },
			]).flat(),
		];

		const result = pruneToFit(messages, 100);
		const userMsgs = result.filter((m) => m.role === "user");
		expect(userMsgs.length).toBeGreaterThan(0);
	});
});

// ============================================================================
// compactMessages
// ============================================================================

describe("compactMessages", () => {
	it("returns compacted messages with summary", async () => {
		const messages: Message[] = [
			{ role: "system", content: "You are helpful." },
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there!" },
			{ role: "user", content: "What is 2+2?" },
			{ role: "assistant", content: "4" },
			{ role: "user", content: "Thanks" },
			{ role: "assistant", content: "You're welcome" },
		];

		const summarize = async (text: string) => `Summary of: ${text.slice(0, 50)}`;

		const result = await compactMessages(messages, summarize, {
			contextWindow: 100_000,
			maxResponseTokens: 8192,
			compactionThreshold: 0.75,
		} as any);

		expect(result.messages.length).toBeLessThan(messages.length);
		expect(result.messages.some((m) => typeof m.content === "string" && m.content.includes("Compacted"))).toBe(true);
		expect(result.summary.messagesCompacted).toBeGreaterThan(0);
		expect(result.summary.tokensBefore).toBeGreaterThan(0);
	});

	it("surfaces tool_calls in the text sent to the summarizer instead of dropping them", async () => {
		// Real messages from this codebase carry tool_calls as a sibling field
		// (OpenAI shape), with content: null when the turn is purely a tool
		// call — not Anthropic-style content blocks. A summarizer that can't
		// see this loses almost everything a coding agent actually did.
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "Read config.ts and tell me the default context window" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "read", arguments: JSON.stringify({ path: "src/config.ts" }) },
					},
				],
			} as unknown as Message,
			{ role: "tool", tool_call_id: "call_1", content: "contextWindow: 128_000" } as unknown as Message,
			{ role: "assistant", content: "128,000 tokens." },
			{ role: "user", content: "Thanks" },
			{ role: "assistant", content: "You're welcome" },
		];

		let capturedText = "";
		const summarize = async (text: string) => {
			capturedText = text;
			return "summary";
		};

		await compactMessages(messages, summarize, {
			contextWindow: 1,
			maxResponseTokens: 0,
			compactionThreshold: 0,
		} as any);

		expect(capturedText).not.toContain("[structured content]");
		expect(capturedText).toContain("read");
		expect(capturedText).toContain("src/config.ts");
	});

	it("appends deterministic read/modified file tags to the summary, extracted from tool_calls", async () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "Look at a.ts, then update b.ts" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{ id: "c1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "a.ts" }) } },
				],
			} as unknown as Message,
			{ role: "tool", tool_call_id: "c1", content: "ok" } as unknown as Message,
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "c2",
						type: "function",
						function: { name: "edit", arguments: JSON.stringify({ path: "b.ts", oldText: "x", newText: "y" }) },
					},
				],
			} as unknown as Message,
			{ role: "tool", tool_call_id: "c2", content: "ok" } as unknown as Message,
			{ role: "assistant", content: "Done" },
			{ role: "user", content: "Thanks" },
			{ role: "assistant", content: "Sure" },
			// Padding so the 60% split point lands after both tool calls above,
			// not between them — otherwise this test would depend on exactly
			// where compactMessages happens to draw the line.
			{ role: "user", content: "One more thing" },
			{ role: "assistant", content: "Sure thing" },
		];

		// File tags are appended deterministically to the model's *output*,
		// not folded into its input — assert both ends: the model never sees
		// the tags (nothing for it to garble or omit)...
		let capturedText = "";
		const summarize = async (text: string) => {
			capturedText = text;
			return "summary";
		};

		const result = await compactMessages(messages, summarize, {
			contextWindow: 1,
			maxResponseTokens: 0,
			compactionThreshold: 0,
		} as any);

		expect(capturedText).not.toContain("<read-files>");

		// ...and the final marker has them regardless of what the model said.
		const marker = result.messages.find(
			(m) => typeof m.content === "string" && m.content.startsWith("[Compacted context"),
		);
		const markerText = marker?.content as string;
		expect(markerText).toContain("<read-files>");
		expect(markerText).toContain("a.ts");
		expect(markerText).toContain("<modified-files>");
		expect(markerText).toContain("b.ts");
	});

	it("skips summarizing when there is no safe cut point (degenerate history)", async () => {
		// A single unbroken assistant/tool pair with nothing before it in the
		// non-system slice: the naive 60% split lands on the tool result, and
		// walking back to a safe boundary has nowhere to go but index 0 —
		// i.e. nothing is safely compactable yet.
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
			} as unknown as Message,
			{ role: "tool", tool_call_id: "c1", content: "output" } as unknown as Message,
		];

		let called = false;
		const summarize = async () => {
			called = true;
			return "should not be called";
		};

		const result = await compactMessages(messages, summarize, {
			contextWindow: 1,
			maxResponseTokens: 0,
			compactionThreshold: 0,
		} as any);

		expect(called).toBe(false);
		expect(result.summary.messagesCompacted).toBe(0);
		expect(result.messages).toBe(messages);
	});

	it("threads an existing compaction summary through as previousSummary instead of stacking markers", async () => {
		const previousMarker =
			"[Compacted context — 5 messages summarized]\n" +
			"## Goal\nBuild a CLI tool.\n\n<read-files>\nold.ts\n</read-files>";

		const messages: Message[] = [
			{ role: "system", content: "You are a coding agent." },
			{ role: "system", content: previousMarker },
			{ role: "user", content: "turn 1" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "c1",
						type: "function",
						function: { name: "read", arguments: JSON.stringify({ path: "new.ts" }) },
					},
				],
			} as unknown as Message,
			{ role: "tool", tool_call_id: "c1", content: "ok" } as unknown as Message,
			{ role: "assistant", content: "read new.ts" },
			{ role: "user", content: "turn 2" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "c2",
						type: "function",
						function: {
							name: "edit",
							arguments: JSON.stringify({ path: "other.ts", oldText: "a", newText: "b" }),
						},
					},
				],
			} as unknown as Message,
			{ role: "tool", tool_call_id: "c2", content: "ok" } as unknown as Message,
			{ role: "assistant", content: "edited other.ts" },
			{ role: "user", content: "turn 3" },
			{ role: "assistant", content: "done" },
		];

		let receivedPreviousSummary: string | undefined;
		const summarize = async (_text: string, previousSummary?: string) => {
			receivedPreviousSummary = previousSummary;
			return "## Goal\nBuild a CLI tool.\n\nUpdated with turns 1-2.";
		};

		const result = await compactMessages(messages, summarize, {
			contextWindow: 1,
			maxResponseTokens: 0,
			compactionThreshold: 0,
		} as any);

		expect(receivedPreviousSummary).toContain("Build a CLI tool");
		expect(receivedPreviousSummary).not.toContain("[Compacted context");

		const compactionMarkers = result.messages.filter(
			(m) => typeof m.content === "string" && m.content.startsWith("[Compacted context"),
		);
		expect(compactionMarkers).toHaveLength(1);

		// File paths from the old marker's tags survive into the new one,
		// merged with paths touched by the newly-compacted turns.
		const markerText = compactionMarkers[0]!.content as string;
		expect(markerText).toContain("old.ts");
		expect(markerText).toContain("new.ts");
		expect(markerText).toContain("other.ts");
	});
});

// ============================================================================
// Compaction never orphans a tool result
// ============================================================================

describe("compaction cut points never split a tool_calls/tool pair", () => {
	/** Irregular history: each user turn gets a random-length chain of
	 * assistant(tool_calls)+tool round trips before a plain-text reply —
	 * matches how a real coding-agent session actually looks, unlike a
	 * uniform period-3 pattern that can hide off-by-one boundary bugs. */
	function buildRealisticHistory(turns: number, seed: number): Message[] {
		let s = seed;
		const rand = () => {
			s = (s * 1103515245 + 12345) & 0x7fffffff;
			return s / 0x7fffffff;
		};
		const messages: Message[] = [{ role: "system", content: "sys" }];
		let callId = 0;
		for (let t = 0; t < turns; t++) {
			messages.push({ role: "user", content: `turn ${t}` });
			const rounds = 1 + Math.floor(rand() * 4);
			for (let r = 0; r < rounds; r++) {
				messages.push({
					role: "assistant",
					content: null,
					tool_calls: [{ id: `c${callId}`, type: "function", function: { name: "bash", arguments: "{}" } }],
				} as unknown as Message);
				messages.push({
					role: "tool",
					tool_call_id: `c${callId}`,
					content: `result ${callId}`,
				} as unknown as Message);
				callId++;
			}
			messages.push({ role: "assistant", content: `done with turn ${t}` });
		}
		return messages;
	}

	function firstDanglingToolIndex(seq: Message[]): number {
		for (let i = 0; i < seq.length; i++) {
			if (seq[i]?.role !== "tool") continue;
			const prev = seq[i - 1] as { role: string; tool_calls?: unknown } | undefined;
			if (!prev || prev.role !== "assistant" || !prev.tool_calls) return i;
		}
		return -1;
	}

	it("pruneToFit never leaves a tool result without its assistant tool_calls", () => {
		for (let seed = 1; seed <= 20; seed++) {
			for (const turns of [10, 15, 20, 25]) {
				const messages = buildRealisticHistory(turns, seed);
				const pruned = pruneToFit(messages, 1); // maxTokens=1 forces pruning every time
				expect(firstDanglingToolIndex(pruned)).toBe(-1);
			}
		}
	});

	it("compactMessages never leaves a tool result without its assistant tool_calls", async () => {
		const summarize = async () => "summary";
		for (let seed = 1; seed <= 20; seed++) {
			for (const turns of [10, 15, 20, 25]) {
				const messages = buildRealisticHistory(turns, seed);
				const result = await compactMessages(messages, summarize, {
					contextWindow: 1,
					maxResponseTokens: 0,
					compactionThreshold: 0,
				} as any);
				expect(firstDanglingToolIndex(result.messages)).toBe(-1);
			}
		}
	});
});

// ============================================================================
// Session persistence — per-project directories, legacy flat files, delete
// ============================================================================

describe("session persistence", () => {
	let realHome: string | undefined;
	let fakeHome: string;
	let projectA: string;
	let projectB: string;

	beforeEach(() => {
		realHome = process.env.HOME;
		fakeHome = mkdtempSync(join(tmpdir(), "cast-session-test-"));
		process.env.HOME = fakeHome;
		projectA = join(fakeHome, "projects", "a");
		projectB = join(fakeHome, "projects", "b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
	});

	afterEach(() => {
		process.env.HOME = realHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	it("createSession records the cwd it was created in", () => {
		const session = createSession("gpt-4o", projectA);
		expect(session.cwd).toBe(projectA);
	});

	it("saveSession/loadSession round-trips a session under its project directory", () => {
		const session = createSession("gpt-4o", projectA);
		session.messages.push({ role: "user", content: "hello" });
		saveSession(session);

		const loaded = loadSession(session.id);
		expect(loaded?.id).toBe(session.id);
		expect(loaded?.cwd).toBe(projectA);
		expect(loaded?.messages).toEqual(session.messages);
	});

	it("keeps sessions from different projects in separate directories", () => {
		const a = createSession("gpt-4o", projectA);
		saveSession(a);
		const b = createSession("gpt-4o", projectB);
		saveSession(b);

		// listSessions must see both even though they're nested under
		// different encoded-cwd subdirectories.
		const all = listSessions().map((s) => s.id);
		expect(all).toContain(a.id);
		expect(all).toContain(b.id);
	});

	it("still finds a legacy flat-file session (no cwd, saved directly under sessions/)", () => {
		const legacy = createSession("gpt-4o", projectA);
		delete (legacy as { cwd?: string }).cwd;
		saveSession(legacy); // cwd-less -> writes to the flat root, not a project subdir

		const loaded = loadSession(legacy.id);
		expect(loaded?.id).toBe(legacy.id);
		expect(loaded?.cwd).toBeUndefined();

		const all = listSessions().map((s) => s.id);
		expect(all).toContain(legacy.id);
	});

	it("deleteSession removes a nested session and reports success", () => {
		const session = createSession("gpt-4o", projectA);
		saveSession(session);

		expect(deleteSession(session.id)).toBe(true);
		expect(loadSession(session.id)).toBeNull();
		expect(listSessions().map((s) => s.id)).not.toContain(session.id);
	});

	it("deleteSession returns false for an id that doesn't exist", () => {
		expect(deleteSession("no-such-session-id")).toBe(false);
	});

	it("deleteSession doesn't touch other sessions in the same or other projects", () => {
		const keep = createSession("gpt-4o", projectA);
		saveSession(keep);
		const other = createSession("gpt-4o", projectB);
		saveSession(other);
		const toDelete = createSession("gpt-4o", projectA);
		saveSession(toDelete);

		deleteSession(toDelete.id);

		const remaining = listSessions().map((s) => s.id);
		expect(remaining).toContain(keep.id);
		expect(remaining).toContain(other.id);
		expect(remaining).not.toContain(toDelete.id);
	});

	it("getMostRecentSession finds the latest across every project", async () => {
		const older = createSession("gpt-4o", projectA);
		saveSession(older);
		// saveSession stamps updatedAt to Date.now() (ms precision) — without a
		// real gap the two saves could land in the same millisecond and tie.
		await new Promise((r) => setTimeout(r, 5));
		const newer = createSession("gpt-4o", projectB);
		saveSession(newer);

		expect(getMostRecentSession()?.id).toBe(newer.id);
	});

	it("formatSessionList shows the project basename, and '-' for cwd-less sessions", () => {
		const withCwd = createSession("gpt-4o", projectA);
		const legacy = createSession("gpt-4o", projectA);
		delete (legacy as { cwd?: string }).cwd;

		const lines = formatSessionList([withCwd, legacy]);
		expect(lines[0]).toContain("a"); // basename of projectA
		expect(lines[1]).toContain(" - "); // no cwd -> "-" placeholder
	});
});
