import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { formatContextFilesForPrompt, resolveNestedContextFiles } from "../src/core/context-files.ts";
import type { Message } from "../src/core/llm.ts";
import { formatRulesForTurn, loadDirectoryRules, matchAutoRules, unionStickyRules } from "../src/core/rules.ts";

vi.mock("../src/core/llm.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/llm.ts")>();
	return {
		...actual,
		createClient: () => ({}),
		// A real abort tears the in-flight request down mid-stream (an
		// APIUserAbortError thrown from inside the fetch), not a clean
		// completion with finishReason: "aborted" — this is what runLoop's
		// outer catch actually has to distinguish from a genuine failure.
		streamAndCollect: vi.fn(
			async (
				_client: unknown,
				_model: string,
				_messages: unknown,
				_tools: unknown,
				_maxTokens: number,
				signal?: AbortSignal,
			) => {
				if (signal?.aborted) throw new Error("Request was aborted.");
				throw new Error("test streamAndCollect stub always throws");
			},
		),
	};
});

const { runAgentLoop, MessageQueue, compactSessionMessages } = await import("../src/core/loop.ts");
const { streamAndCollect } = await import("../src/core/llm.ts");
type AgentEvent = Parameters<Parameters<typeof runAgentLoop>[1]["onEvent"]>[0];

beforeEach(() => {
	// vitest doesn't reset mock call history/queued mockImplementationOnce
	// calls between tests by default (no clearMocks/restoreMocks in this
	// project's vitest config) — without this, toHaveBeenCalledTimes and
	// leftover one-shot implementations from an earlier test bleed into the
	// next one.
	vi.mocked(streamAndCollect).mockClear();
});

// ============================================================================
// MessageQueue
// ============================================================================

describe("MessageQueue", () => {
	it("starts empty", () => {
		const q = new MessageQueue();
		expect(q.hasItems()).toBe(false);
		expect(q.length).toBe(0);
		expect(q.drain()).toEqual([]);
	});

	it("enqueues and drains one-at-a-time", () => {
		const q = new MessageQueue();
		const msg1: Message = { role: "user", content: "first" };
		const msg2: Message = { role: "user", content: "second" };

		q.enqueue(msg1);
		q.enqueue(msg2);

		expect(q.hasItems()).toBe(true);
		expect(q.length).toBe(2);

		const first = q.drain();
		expect(first).toEqual([msg1]);
		expect(q.length).toBe(1);

		const second = q.drain();
		expect(second).toEqual([msg2]);
		expect(q.length).toBe(0);

		expect(q.drain()).toEqual([]);
	});

	it("clear removes all messages", () => {
		const q = new MessageQueue();
		q.enqueue({ role: "user", content: "a" });
		q.enqueue({ role: "user", content: "b" });

		expect(q.length).toBe(2);
		q.clear();
		expect(q.length).toBe(0);
		expect(q.hasItems()).toBe(false);
	});

	it("drains one message at a time", () => {
		const q = new MessageQueue();
		q.enqueue({ role: "user", content: "a" });
		q.enqueue({ role: "user", content: "b" });

		const first = q.drain();
		expect(first.length).toBe(1);
		expect(q.length).toBe(1);
	});
});

// ============================================================================
// runAgentLoop — abort vs. genuine error
// ============================================================================

const testConfig: AppConfig = {
	baseURL: "http://localhost",
	apiKey: "test",
	contextWindow: 128_000,
	maxResponseTokens: 8192,
	compactionThreshold: 0.75,
	maxToolOutputLines: 2000,
	maxToolOutputBytes: 64 * 1024,
	defaultBashTimeout: 120,
	reasoningLevel: "off",
	reasoningParams: { body: {} },
};

describe("runAgentLoop — abort vs. error", () => {
	it("reports reason 'aborted' (not 'error') when the request was aborted mid-stream", async () => {
		const controller = new AbortController();
		const events: AgentEvent[] = [];

		// A real abort fires *while a request is in flight* — not before it
		// even starts, which the loop's own top-of-iteration `signal?.aborted`
		// check already handled correctly. This simulates the actual failure
		// mode: /abort tears down the fetch mid-stream, and only *then* is the
		// signal marked aborted, so the exception has to be caught and
		// classified after the fact — that classification is what this fix is
		// actually about.
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => {
			controller.abort();
			throw new Error("Request was aborted.");
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			signal: controller.signal,
			onEvent: (event) => events.push(event),
		});

		const endEvent = events.find((e) => e.type === "end");
		expect(endEvent).toEqual({ type: "end", reason: "aborted" });
		// A genuine "error" event must not also fire for a plain abort — that's
		// exactly what made the UI show the literal word "error" instead of
		// "Aborted" (see useAgentSession.ts's "end" case).
		expect(events.some((e) => e.type === "error")).toBe(false);
		expect(events.some((e) => e.type === "interrupt_reminder")).toBe(true);
	});

	it("reports 'aborted' when a mid-stream abort ends the stream cleanly (no exception)", async () => {
		const controller = new AbortController();
		const events: AgentEvent[] = [];

		// Undici can end the async iterator cleanly on a mid-stream abort instead
		// of throwing: streamAndCollect returns a partial result and reports
		// interrupted=true (aborted before a natural finish_reason). This is the
		// "Esc during reasoning shows no Aborted" case — without the post-stream
		// check the turn would commit as a normal stop.
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => {
			controller.abort();
			return { content: "partial answer", thinking: "was mid-reasoning", finishReason: "stop", interrupted: true };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			signal: controller.signal,
			onEvent: (event) => events.push(event),
		});

		const endEvent = events.find((e) => e.type === "end");
		expect(endEvent).toEqual({ type: "end", reason: "aborted" });
		expect(events.some((e) => e.type === "error")).toBe(false);
		// The partial turn must not have been committed as a finished assistant
		// message (no turn_end) — it ends as an abort, not a normal stop.
		expect(events.some((e) => e.type === "turn_end")).toBe(false);
		expect(events.some((e) => e.type === "interrupt_reminder")).toBe(true);
	});

	it("appends an interrupt system-reminder into messages on mid-stream abort", async () => {
		const controller = new AbortController();
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => {
			controller.abort();
			return { content: "half", thinking: "", finishReason: "stop", interrupted: true };
		});

		const events: AgentEvent[] = [];
		const messages = await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			signal: controller.signal,
			onEvent: (event) => events.push(event),
		});

		expect(events.some((e) => e.type === "interrupt_reminder")).toBe(true);
		const reminder = messages.find(
			(m) =>
				m.role === "user" &&
				typeof m.content === "string" &&
				m.content.includes("[Request interrupted by user]") &&
				m.content.includes("<system-reminder>"),
		);
		expect(reminder).toBeDefined();
	});

	it("does NOT report 'aborted' when the turn finished just before a late abort", async () => {
		const controller = new AbortController();
		const events: AgentEvent[] = [];

		// The stream reached a natural finish_reason (interrupted=false), and only
		// then did a late Esc set the signal. A completed answer must not be
		// mislabeled "Aborted" — it commits as a normal stop.
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => {
			controller.abort();
			return { content: "Привет.", thinking: "", finishReason: "stop", interrupted: false };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			signal: controller.signal,
			onEvent: (event) => events.push(event),
		});

		const endEvent = events.find((e) => e.type === "end");
		expect(endEvent).toEqual({ type: "end", reason: "stop" });
		expect(events.some((e) => e.type === "turn_end")).toBe(true);
		expect(events.some((e) => e.type === "interrupt_reminder")).toBe(false);
	});

	it("reports 'disconnected' when the stream is silently truncated (no finish, no usage, no abort)", async () => {
		const events: AgentEvent[] = [];

		// Provider dropped mid-response: the stream ended cleanly but never sent a
		// finish_reason or usage summary, and there was no user abort. Must not
		// look like a normal stop.
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => {
			return { content: "half an ans", thinking: "", finishReason: "stop", disconnected: true };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			onEvent: (event) => events.push(event),
		});

		const endEvent = events.find((e) => e.type === "end");
		expect(endEvent).toEqual({ type: "end", reason: "disconnected" });
		expect(events.some((e) => e.type === "turn_end")).toBe(false);
		expect(events.some((e) => e.type === "error")).toBe(false);
	});

	it("still reports reason 'error' for a genuine failure unrelated to abort", async () => {
		const events: AgentEvent[] = [];

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			// No signal at all — streamAndCollect's stub throws its "always
			// throws" error, unrelated to any abort.
			onEvent: (event) => events.push(event),
		});

		const endEvent = events.find((e) => e.type === "end");
		expect(endEvent).toEqual({ type: "end", reason: "error" });
		expect(events.some((e) => e.type === "error")).toBe(true);
	});
});

// ============================================================================
// runAgentLoop — /steer and /fu (steering + follow-up injection)
// ============================================================================

describe("runAgentLoop — steering and follow-up injection", () => {
	it("injects a steering message enqueued mid-run and carries its content on the event", async () => {
		const steeringQueue = new MessageQueue();
		const events: AgentEvent[] = [];

		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => {
				// Simulate /steer arriving while this first request is in flight —
				// the loop only re-checks the queue after this turn ends.
				steeringQueue.enqueue({ role: "user", content: "steered instruction" });
				return { content: "first response", thinking: "", finishReason: "stop" };
			})
			.mockImplementationOnce(async () => ({ content: "second response", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			steeringQueue,
			// Snapshot immediately: applyCacheControl mutates message objects
			// in-place on later turns (adds cache_control markers), and this event
			// holds the *same* object references, not copies — matching what the
			// real consumer (useAgentSession.ts) does, extracting content
			// synchronously in the same tick rather than holding onto the event.
			onEvent: (event) => events.push(structuredClone(event)),
		});

		const steeringEvent = events.find((e) => e.type === "steering_injected");
		expect(steeringEvent?.type).toBe("steering_injected");
		expect(steeringEvent && "messages" in steeringEvent ? steeringEvent.messages : undefined).toEqual([
			{ role: "user", content: "steered instruction" },
		]);
		expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(2);
		expect(events.find((e) => e.type === "end")).toEqual({ type: "end", reason: "stop" });
	});

	it("drains multiple queued steering messages one at a time, across separate turns", async () => {
		// MessageQueue.drain() (see loop.ts) only ever returns one message —
		// queuing two /steer messages before the current turn ends must not
		// collapse them into a single steering_injected event, or the UI's
		// pending-count indicator (useAgentSession.ts's pendingSteers) would
		// have nothing left to shift for the second one and show it as
		// consumed before it actually was.
		const steeringQueue = new MessageQueue();
		const events: AgentEvent[] = [];

		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => {
				steeringQueue.enqueue({ role: "user", content: "first steer" });
				steeringQueue.enqueue({ role: "user", content: "second steer" });
				return { content: "response 1", thinking: "", finishReason: "stop" };
			})
			.mockImplementationOnce(async () => ({ content: "response 2", thinking: "", finishReason: "stop" }))
			.mockImplementationOnce(async () => ({ content: "response 3", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			steeringQueue,
			onEvent: (event) => events.push(structuredClone(event)),
		});

		const steeringEvents = events.filter((e) => e.type === "steering_injected");
		expect(steeringEvents).toHaveLength(2);
		expect(steeringEvents[0]?.type === "steering_injected" && steeringEvents[0].messages).toEqual([
			{ role: "user", content: "first steer" },
		]);
		expect(steeringEvents[1]?.type === "steering_injected" && steeringEvents[1].messages).toEqual([
			{ role: "user", content: "second steer" },
		]);
		expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(3);

		// Mirrors useAgentSession.ts's pendingSteers bookkeeping: append on
		// steer(), shift the front off on each steering_injected. Should count
		// down 2 -> 1 -> 0, never jumping straight to empty and hiding the
		// still-queued second message.
		let pendingSteers: string[] = ["first steer", "second steer"];
		const pendingCounts: number[] = [];
		for (const event of steeringEvents) {
			if (event.type !== "steering_injected") continue;
			pendingSteers = pendingSteers.slice(event.messages.length);
			pendingCounts.push(pendingSteers.length);
		}
		expect(pendingCounts).toEqual([1, 0]);
	});

	it("injects a follow-up message queued after the agent would otherwise stop", async () => {
		const followUpQueue = new MessageQueue();
		const events: AgentEvent[] = [];

		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => {
				followUpQueue.enqueue({ role: "user", content: "follow-up instruction" });
				return { content: "first response", thinking: "", finishReason: "stop" };
			})
			.mockImplementationOnce(async () => ({ content: "second response", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			followUpQueue,
			onEvent: (event) => events.push(structuredClone(event)),
		});

		const followUpEvent = events.find((e) => e.type === "followup_injected");
		expect(followUpEvent?.type).toBe("followup_injected");
		expect(followUpEvent && "messages" in followUpEvent ? followUpEvent.messages : undefined).toEqual([
			{ role: "user", content: "follow-up instruction" },
		]);
		expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(2);
		expect(events.find((e) => e.type === "end")).toEqual({ type: "end", reason: "stop" });
	});
});

// ============================================================================
// runAgentLoop — rules auto-attach through the real loop (end-to-end stitch)
// ============================================================================

describe("runAgentLoop — context files drive rule auto-attach", () => {
	it("a real read tool call latches a glob rule into the next turn's system prompt", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cast-loop-rules-"));
		try {
			// A real file the agent will `read`, and two rules: one always-apply
			// (must appear every turn) and one auto-attach on **/*.tsx (must appear
			// only after the .tsx file enters context via the tool call).
			mkdirSync(join(cwd, "src"), { recursive: true });
			writeFileSync(join(cwd, "src", "App.tsx"), "export const App = () => null;");
			const rulesDir = join(cwd, ".cast", "rules");
			mkdirSync(rulesDir, { recursive: true });
			writeFileSync(join(rulesDir, "root.md"), "---\nalwaysApply: true\n---\nALWAYS_RULE_BODY");
			writeFileSync(join(rulesDir, "web.md"), '---\nglobs: ["**/*.tsx"]\n---\nWEB_RULE_BODY');
			const catalog = loadDirectoryRules({ projectCwd: cwd });

			// Mirror App.tsx's rebuild: latch sticky auto rules, record each prompt.
			let sticky: ReturnType<typeof matchAutoRules> = [];
			const prompts: string[] = [];
			const rebuildSystemPrompt = ({ contextFiles }: { userText: string; contextFiles: string[] }) => {
				sticky = unionStickyRules(sticky, matchAutoRules(catalog, contextFiles));
				const p = `SYS${formatRulesForTurn(catalog, sticky, [])}`;
				prompts.push(p);
				return p;
			};

			const followUpQueue = new MessageQueue();
			vi.mocked(streamAndCollect)
				// Turn 1, call 1: the model asks to read the .tsx file.
				.mockImplementationOnce(async () => ({
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [{ id: "t1", name: "read", arguments: JSON.stringify({ path: "src/App.tsx" }) }],
				}))
				// Turn 1, call 2: tool result is back; model stops. Queue a follow-up
				// so the outer loop runs again (rebuild only fires per outer turn).
				.mockImplementationOnce(async () => {
					followUpQueue.enqueue({ role: "user", content: "continue" });
					return { content: "read done", thinking: "", finishReason: "stop" };
				})
				// Turn 2: nothing more to do.
				.mockImplementationOnce(async () => ({ content: "second turn", thinking: "", finishReason: "stop" }));

			await runAgentLoop([{ role: "user", content: "look at the component" }], {
				config: testConfig,
				model: "test-model",
				cwd,
				systemPrompt: "SYS",
				followUpQueue,
				rebuildSystemPrompt,
				onEvent: () => {},
			});

			// Turn 1's prompt: always rule present, web rule NOT yet (no file in
			// context when the turn began).
			expect(prompts[0]).toContain("ALWAYS_RULE_BODY");
			expect(prompts[0]).not.toContain("WEB_RULE_BODY");
			// Turn 2's prompt: the read populated contextFiles, so the .tsx glob
			// rule has now latched — alongside the always rule.
			const last = prompts.at(-1)!;
			expect(last).toContain("ALWAYS_RULE_BODY");
			expect(last).toContain("WEB_RULE_BODY");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("attaches a glob rule within the SAME submit — the request after the read already carries it", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cast-loop-rules2-"));
		try {
			mkdirSync(join(cwd, "src"), { recursive: true });
			writeFileSync(join(cwd, "src", "App.tsx"), "export const App = () => null;");
			const rulesDir = join(cwd, ".cast", "rules");
			mkdirSync(rulesDir, { recursive: true });
			writeFileSync(join(rulesDir, "web.md"), '---\nglobs: ["**/*.tsx"]\n---\nWEB_RULE_BODY');
			const catalog = loadDirectoryRules({ projectCwd: cwd });

			let sticky: ReturnType<typeof matchAutoRules> = [];
			const rebuildSystemPrompt = ({ contextFiles }: { userText: string; contextFiles: string[] }) => {
				sticky = unionStickyRules(sticky, matchAutoRules(catalog, contextFiles));
				return `SYS${formatRulesForTurn(catalog, sticky, [])}`;
			};

			// Capture the system prompt (messages[0]) actually sent on each request.
			const sentPrompts: string[] = [];
			vi.mocked(streamAndCollect)
				// Request 1: no file seen yet → prompt must NOT carry the rule.
				.mockImplementationOnce(async (_c, _m, msgs) => {
					sentPrompts.push(JSON.stringify((msgs as Message[])[0]?.content ?? ""));
					return {
						content: "",
						thinking: "",
						finishReason: "stop",
						toolCalls: [{ id: "r1", name: "read", arguments: JSON.stringify({ path: "src/App.tsx" }) }],
					};
				})
				// Request 2: same submit, continuation after the read → the rule
				// must already be present without any follow-up message.
				.mockImplementationOnce(async (_c, _m, msgs) => {
					sentPrompts.push(JSON.stringify((msgs as Message[])[0]?.content ?? ""));
					return { content: "done", thinking: "", finishReason: "stop" };
				});

			await runAgentLoop([{ role: "user", content: "read the component" }], {
				config: testConfig,
				model: "test-model",
				cwd,
				systemPrompt: "SYS",
				rebuildSystemPrompt,
				contextFiles: [],
				onEvent: () => {},
			});

			expect(sentPrompts).toHaveLength(2);
			expect(sentPrompts[0]).not.toContain("WEB_RULE_BODY"); // before the read
			expect(sentPrompts[1]).toContain("WEB_RULE_BODY"); // right after the read, same turn
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ============================================================================
// runAgentLoop — nested AGENTS.md injection end-to-end
// ============================================================================

describe("runAgentLoop — nested AGENTS.md injection", () => {
	it("a read in a subdirectory with its own AGENTS.md injects it into the next system prompt", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cast-loop-nested-agents-"));
		try {
			// Set up a monorepo-like structure:
			//   <cwd>/AGENTS.md            — "ROOT_INSTRUCTIONS" (static base)
			//   <cwd>/apps/web/AGENTS.md   — "WEB_INSTRUCTIONS" (nested, should appear after read)
			//   <cwd>/apps/web/App.tsx     — the file the agent reads
			mkdirSync(join(cwd, "apps", "web"), { recursive: true });
			writeFileSync(join(cwd, "AGENTS.md"), "ROOT_INSTRUCTIONS", "utf-8");
			writeFileSync(join(cwd, "apps", "web", "AGENTS.md"), "WEB_INSTRUCTIONS", "utf-8");
			writeFileSync(join(cwd, "apps", "web", "App.tsx"), "export const App = () => null;", "utf-8");

			const baseSuffix = formatContextFilesForPrompt([
				{ path: join(cwd, "AGENTS.md"), content: "ROOT_INSTRUCTIONS" },
			]);
			const prompts: string[] = [];
			const rebuildSystemPrompt = ({ contextFiles: ctxFiles }: { userText: string; contextFiles: string[] }) => {
				const nested = formatContextFilesForPrompt(resolveNestedContextFiles(cwd, ctxFiles));
				const p = `SYS${baseSuffix}${nested}`;
				prompts.push(p);
				return p;
			};

			const followUpQueue = new (await import("../src/core/loop.ts")).MessageQueue();
			vi.mocked(streamAndCollect)
				.mockImplementationOnce(async () => ({
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [
						{
							id: "t1",
							name: "read",
							arguments: JSON.stringify({ path: "apps/web/App.tsx" }),
						},
					],
				}))
				.mockImplementationOnce(async () => {
					followUpQueue.enqueue({ role: "user", content: "continue" });
					return { content: "read done", thinking: "", finishReason: "stop" };
				})
				.mockImplementationOnce(async () => ({
					content: "second turn",
					thinking: "",
					finishReason: "stop",
				}));

			await runAgentLoop([{ role: "user", content: "read the component" }], {
				config: testConfig,
				model: "test-model",
				cwd,
				systemPrompt: "SYS",
				followUpQueue,
				rebuildSystemPrompt,
				onEvent: () => {},
			});

			expect(prompts[0]).toContain("ROOT_INSTRUCTIONS");
			expect(prompts[0]).not.toContain("WEB_INSTRUCTIONS");
			const last = prompts.at(-1)!;
			expect(last).toContain("ROOT_INSTRUCTIONS");
			expect(last).toContain("WEB_INSTRUCTIONS");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("nested AGENTS.md appears in the SAME turn — the request right after the read carries it", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cast-loop-nested-agents2-"));
		try {
			mkdirSync(join(cwd, "apps", "web"), { recursive: true });
			writeFileSync(join(cwd, "AGENTS.md"), "ROOT_INSTRUCTIONS", "utf-8");
			writeFileSync(join(cwd, "apps", "web", "AGENTS.md"), "WEB_INSTRUCTIONS", "utf-8");
			writeFileSync(join(cwd, "apps", "web", "App.tsx"), "export const App = () => null;", "utf-8");

			const baseSuffix = formatContextFilesForPrompt([
				{ path: join(cwd, "AGENTS.md"), content: "ROOT_INSTRUCTIONS" },
			]);
			const rebuildSystemPrompt = ({ contextFiles: ctxFiles }: { userText: string; contextFiles: string[] }) => {
				const nested = formatContextFilesForPrompt(resolveNestedContextFiles(cwd, ctxFiles));
				return `SYS${baseSuffix}${nested}`;
			};

			const sentPrompts: string[] = [];
			vi.mocked(streamAndCollect)
				.mockImplementationOnce(async (_c, _m, msgs) => {
					sentPrompts.push(JSON.stringify((msgs as Message[])[0]?.content ?? ""));
					return {
						content: "",
						thinking: "",
						finishReason: "stop",
						toolCalls: [
							{
								id: "r1",
								name: "read",
								arguments: JSON.stringify({ path: "apps/web/App.tsx" }),
							},
						],
					};
				})
				.mockImplementationOnce(async (_c, _m, msgs) => {
					sentPrompts.push(JSON.stringify((msgs as Message[])[0]?.content ?? ""));
					return { content: "done", thinking: "", finishReason: "stop" };
				});

			await runAgentLoop([{ role: "user", content: "read the component" }], {
				config: testConfig,
				model: "test-model",
				cwd,
				systemPrompt: "SYS",
				rebuildSystemPrompt,
				contextFiles: [],
				onEvent: () => {},
			});

			expect(sentPrompts).toHaveLength(2);
			expect(sentPrompts[0]).not.toContain("WEB_INSTRUCTIONS");
			expect(sentPrompts[1]).toContain("WEB_INSTRUCTIONS");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("deeply nested AGENTS.md (3 levels) attaches the full chain shallow-to-deep", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cast-loop-nested-agents3-"));
		try {
			mkdirSync(join(cwd, "apps", "web", "components"), { recursive: true });
			writeFileSync(join(cwd, "AGENTS.md"), "ROOT", "utf-8");
			writeFileSync(join(cwd, "apps", "web", "AGENTS.md"), "WEB", "utf-8");
			writeFileSync(join(cwd, "apps", "web", "components", "AGENTS.md"), "COMPONENTS", "utf-8");
			writeFileSync(
				join(cwd, "apps", "web", "components", "Button.tsx"),
				"export const Button = () => null;",
				"utf-8",
			);

			const baseSuffix = formatContextFilesForPrompt([{ path: join(cwd, "AGENTS.md"), content: "ROOT" }]);
			const prompts: string[] = [];
			const rebuildSystemPrompt = ({ contextFiles: ctxFiles }: { userText: string; contextFiles: string[] }) => {
				const nested = formatContextFilesForPrompt(resolveNestedContextFiles(cwd, ctxFiles));
				const p = `SYS${baseSuffix}${nested}`;
				prompts.push(p);
				return p;
			};

			const followUpQueue = new (await import("../src/core/loop.ts")).MessageQueue();
			vi.mocked(streamAndCollect)
				.mockImplementationOnce(async () => ({
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [
						{
							id: "t1",
							name: "read",
							arguments: JSON.stringify({ path: "apps/web/components/Button.tsx" }),
						},
					],
				}))
				.mockImplementationOnce(async () => {
					followUpQueue.enqueue({ role: "user", content: "continue" });
					return { content: "read done", thinking: "", finishReason: "stop" };
				})
				.mockImplementationOnce(async () => ({
					content: "second turn",
					thinking: "",
					finishReason: "stop",
				}));

			await runAgentLoop([{ role: "user", content: "read the button" }], {
				config: testConfig,
				model: "test-model",
				cwd,
				systemPrompt: "SYS",
				followUpQueue,
				rebuildSystemPrompt,
				onEvent: () => {},
			});

			expect(prompts[0]).toContain("ROOT");
			expect(prompts[0]).not.toContain("WEB");
			expect(prompts[0]).not.toContain("COMPONENTS");

			const last = prompts.at(-1)!;
			expect(last).toContain("ROOT");
			const webIdx = last.indexOf("WEB");
			const compIdx = last.indexOf("COMPONENTS");
			expect(webIdx).toBeGreaterThan(-1);
			expect(compIdx).toBeGreaterThan(webIdx);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("scoped: reading a file in services/ does NOT pull apps/web/ AGENTS.md", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cast-loop-nested-agents4-"));
		try {
			mkdirSync(join(cwd, "apps", "web"), { recursive: true });
			mkdirSync(join(cwd, "services", "api"), { recursive: true });
			writeFileSync(join(cwd, "AGENTS.md"), "ROOT", "utf-8");
			writeFileSync(join(cwd, "apps", "web", "AGENTS.md"), "WEB", "utf-8");
			writeFileSync(join(cwd, "services", "api", "AGENTS.md"), "API", "utf-8");
			writeFileSync(join(cwd, "services", "api", "main.go"), "package main", "utf-8");

			const baseSuffix = formatContextFilesForPrompt([{ path: join(cwd, "AGENTS.md"), content: "ROOT" }]);
			const prompts: string[] = [];
			const rebuildSystemPrompt = ({ contextFiles: ctxFiles }: { userText: string; contextFiles: string[] }) => {
				const nested = formatContextFilesForPrompt(resolveNestedContextFiles(cwd, ctxFiles));
				const p = `SYS${baseSuffix}${nested}`;
				prompts.push(p);
				return p;
			};

			const followUpQueue = new (await import("../src/core/loop.ts")).MessageQueue();
			vi.mocked(streamAndCollect)
				.mockImplementationOnce(async () => ({
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [
						{
							id: "t1",
							name: "read",
							arguments: JSON.stringify({ path: "services/api/main.go" }),
						},
					],
				}))
				.mockImplementationOnce(async () => {
					followUpQueue.enqueue({ role: "user", content: "continue" });
					return { content: "read done", thinking: "", finishReason: "stop" };
				})
				.mockImplementationOnce(async () => ({
					content: "second turn",
					thinking: "",
					finishReason: "stop",
				}));

			await runAgentLoop([{ role: "user", content: "read the go file" }], {
				config: testConfig,
				model: "test-model",
				cwd,
				systemPrompt: "SYS",
				followUpQueue,
				rebuildSystemPrompt,
				onEvent: () => {},
			});

			const last = prompts.at(-1)!;
			expect(last).toContain("ROOT");
			expect(last).toContain("API");
			expect(last).not.toContain("WEB");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ============================================================================
// runAgentLoop — plan mode
// ============================================================================

// applyCacheControl rewrites message content in place into a structured
// [{ type: "text", text }] array before the request goes out — flatten it
// back to text to assert on prompts.
const contentToText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((p: { type?: string; text?: string }) => (p?.type === "text" && typeof p.text === "string" ? p.text : ""))
		.join("");
};

describe("runAgentLoop — plan mode", () => {
	it("prepends the plan block even when rebuildSystemPrompt replaces the prompt", async () => {
		// rebuildSystemPrompt is always set in the TUI and rebuilds the prompt
		// wholesale — the plan block must be applied after it, not overwritten.
		const systemPrompts: string[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(
			async (_client: unknown, _model: string, messages: unknown) => {
				systemPrompts.push(contentToText((messages as Message[])[0]!.content));
				return { content: "ok", thinking: "", finishReason: "stop" };
			},
		);

		await runAgentLoop([{ role: "user", content: "plan the feature" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "BASE_PROMPT",
			rebuildSystemPrompt: () => "REBUILT_PROMPT",
			planState: { enabled: true, plansDir: "/tmp/never-existing-plans-dir" },
			onEvent: () => {},
		});

		const prompt = systemPrompts[0]!;
		expect(prompt.startsWith("═")).toBe(true);
		expect(prompt).toContain("PLAN MODE ACTIVE");
		// The rebuilt prompt survives below the block — and only once.
		expect(prompt).toContain("REBUILT_PROMPT");
		expect(prompt.indexOf("PLAN MODE ACTIVE")).toBe(prompt.lastIndexOf("PLAN MODE ACTIVE"));
		expect(prompt).not.toContain("BASE_PROMPT");
	});

	it("injects neither block when plan mode is off and no plan was written", async () => {
		const systemPrompts: string[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(
			async (_client: unknown, _model: string, messages: unknown) => {
				systemPrompts.push(contentToText((messages as Message[])[0]!.content));
				return { content: "ok", thinking: "", finishReason: "stop" };
			},
		);

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "BASE_PROMPT",
			planState: { enabled: false, plansDir: "/tmp/never-existing-plans-dir" },
			onEvent: () => {},
		});

		expect(systemPrompts[0]).toBe("BASE_PROMPT");
	});

	it("appends the approved plan in build mode when a plan file exists", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-plan-build-"));
		writeFileSync(join(dir, "feature.md"), "# Plan\n\n## Steps\n1. PLAN_STEP_MARKER", "utf-8");
		try {
			const systemPrompts: string[] = [];
			vi.mocked(streamAndCollect).mockImplementationOnce(
				async (_client: unknown, _model: string, messages: unknown) => {
					systemPrompts.push(contentToText((messages as Message[])[0]!.content));
					return { content: "ok", thinking: "", finishReason: "stop" };
				},
			);

			await runAgentLoop([{ role: "user", content: "go" }], {
				config: testConfig,
				model: "test-model",
				cwd: "/tmp",
				systemPrompt: "BASE_PROMPT",
				rebuildSystemPrompt: () => "REBUILT_PROMPT",
				planState: { enabled: false, plansDir: dir },
				onEvent: () => {},
			});

			const prompt = systemPrompts[0]!;
			// Guidance, not restriction: the base prompt (persona) stays on top.
			expect(prompt.startsWith("REBUILT_PROMPT")).toBe(true);
			expect(prompt).toContain("PLAN_STEP_MARKER");
			expect(prompt).not.toContain("PLAN MODE ACTIVE");
			expect(prompt).not.toContain("{{PLAN}}");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("snapshots the plan per run — mid-run file changes don't churn the system prompt", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-plan-snapshot-"));
		const planPath = join(dir, "feature.md");
		writeFileSync(planPath, "# Plan\n\n## Steps\n- [ ] SNAPSHOT_V1", "utf-8");
		try {
			const systemPrompts: string[] = [];
			const capture = async (_client: unknown, _model: string, messages: unknown) => {
				systemPrompts.push(contentToText((messages as Message[])[0]!.content));
				return { content: "", thinking: "", finishReason: "stop" };
			};
			vi.mocked(streamAndCollect)
				// Request 1: model asks for a read; between requests the plan file
				// changes on disk (as plan_check would do).
				.mockImplementationOnce(async (_c: unknown, _m: string, messages: unknown) => {
					systemPrompts.push(contentToText((messages as Message[])[0]!.content));
					writeFileSync(planPath, "# Plan\n\n## Steps\n- [x] SNAPSHOT_V2", "utf-8");
					return {
						content: "",
						thinking: "",
						finishReason: "stop",
						toolCalls: [{ id: "t1", name: "ls", arguments: JSON.stringify({ path: "." }) }],
					};
				})
				.mockImplementationOnce(capture);

			await runAgentLoop([{ role: "user", content: "go" }], {
				config: testConfig,
				model: "test-model",
				cwd: "/tmp",
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				onEvent: () => {},
			});

			expect(systemPrompts).toHaveLength(2);
			expect(systemPrompts[0]).toContain("SNAPSHOT_V1");
			// Same prompt on the second request — the mid-run edit is invisible
			// until the next run, keeping the provider prompt cache intact.
			expect(systemPrompts[1]).toBe(systemPrompts[0]);
			expect(systemPrompts[1]).not.toContain("SNAPSHOT_V2");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("replaces the mirror with a short reference once every checklist item is checked", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-plan-done-"));
		writeFileSync(join(dir, "feature.md"), "# Plan\n\n## Steps\n- [x] step one\n- [x] step two", "utf-8");
		try {
			const systemPrompts: string[] = [];
			vi.mocked(streamAndCollect).mockImplementationOnce(
				async (_client: unknown, _model: string, messages: unknown) => {
					systemPrompts.push(contentToText((messages as Message[])[0]!.content));
					return { content: "ok", thinking: "", finishReason: "stop" };
				},
			);

			await runAgentLoop([{ role: "user", content: "hi" }], {
				config: testConfig,
				model: "test-model",
				cwd: "/tmp",
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				onEvent: () => {},
			});

			const prompt = systemPrompts[0]!;
			expect(prompt).toContain("fully executed");
			expect(prompt).toContain("feature");
			expect(prompt).not.toContain("step one");
			expect(prompt).not.toContain("<plan>");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("names the session's other plans in the mirror block", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-plan-others-"));
		writeFileSync(join(dir, "alt.md"), "# Alt\n\n## Steps\n- [ ] other work", "utf-8");
		writeFileSync(join(dir, "feature.md"), "# Plan\n\n## Steps\n- [ ] ACTIVE_MARKER", "utf-8");
		// alt is older → feature resolves as the active plan.
		const past = new Date(Date.now() - 60_000);
		utimesSync(join(dir, "alt.md"), past, past);
		try {
			const systemPrompts: string[] = [];
			vi.mocked(streamAndCollect).mockImplementationOnce(
				async (_client: unknown, _model: string, messages: unknown) => {
					systemPrompts.push(contentToText((messages as Message[])[0]!.content));
					return { content: "ok", thinking: "", finishReason: "stop" };
				},
			);

			await runAgentLoop([{ role: "user", content: "go" }], {
				config: testConfig,
				model: "test-model",
				cwd: "/tmp",
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				onEvent: () => {},
			});

			const prompt = systemPrompts[0]!;
			expect(prompt).toContain("ACTIVE_MARKER");
			expect(prompt).toContain("Other plans in this session: alt");
			// The other plan is named, not injected.
			expect(prompt).not.toContain("other work");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("restricts bash to read-only commands in plan mode at the executor", async () => {
		const events: AgentEvent[] = [];
		vi.mocked(streamAndCollect)
			// One mutating call, one read-only call in the same batch.
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [
					{ id: "t1", name: "bash", arguments: JSON.stringify({ command: "touch /tmp/evil" }) },
					{ id: "t2", name: "bash", arguments: JSON.stringify({ command: "echo PLAN_OK" }) },
				],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "explore" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "SYS",
			planState: { enabled: true, plansDir: "/tmp/never-existing-plans-dir" },
			onEvent: (e) => events.push(e),
		});

		const ends = events.filter((e) => e.type === "tool_end");
		expect(ends).toHaveLength(2);
		const mutating = ends.find((e) => e.type === "tool_end" && e.id === "t1");
		const readonly = ends.find((e) => e.type === "tool_end" && e.id === "t2");
		if (mutating?.type === "tool_end") {
			expect(mutating.result.isError).toBe(true);
			expect(mutating.result.content).toContain("read-only");
		}
		if (readonly?.type === "tool_end") {
			expect(readonly.result.isError).toBeFalsy();
			expect(readonly.result.content).toContain("PLAN_OK");
		}
	});

	it("readOnlyBash restricts a subagent's bash without the plan-mode block", async () => {
		const events: AgentEvent[] = [];
		const systemPrompts: string[] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async (_c: unknown, _m: string, messages: unknown) => {
				systemPrompts.push(contentToText((messages as Message[])[0]!.content));
				return {
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [
						{ id: "t1", name: "bash", arguments: JSON.stringify({ command: "touch /tmp/evil" }) },
						{ id: "t2", name: "bash", arguments: JSON.stringify({ command: "echo CHILD_OK" }) },
					],
				};
			})
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "explore" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "CHILD_SYS",
			planState: { enabled: false, plansDir: "/tmp/never-existing-plans-dir" },
			readOnlyBash: true,
			onEvent: (e) => events.push(e),
		});

		// The child is told about the restriction, without the authoring block.
		expect(systemPrompts[0]).toContain("INSPECTION-ONLY");
		expect(systemPrompts[0]).not.toContain("PLAN MODE ACTIVE");

		const ends = events.filter((e) => e.type === "tool_end");
		const mutating = ends.find((e) => e.type === "tool_end" && e.id === "t1");
		const readonly = ends.find((e) => e.type === "tool_end" && e.id === "t2");
		if (mutating?.type === "tool_end") {
			expect(mutating.result.isError).toBe(true);
			expect(mutating.result.content).toContain("read-only");
		}
		if (readonly?.type === "tool_end") {
			expect(readonly.result.isError).toBeFalsy();
			expect(readonly.result.content).toContain("CHILD_OK");
		}
	});

	it("refuses to execute a disabled tool the model fabricates a call to", async () => {
		const events: AgentEvent[] = [];
		vi.mocked(streamAndCollect)
			// The model calls bash even though it was filtered from the definitions.
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t1", name: "bash", arguments: JSON.stringify({ command: "rm -rf /" }) }],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "plan it" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "SYS",
			disabledTools: new Set(["bash"]),
			onEvent: (e) => events.push(e),
		});

		const toolEnd = events.find((e) => e.type === "tool_end");
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_end") {
			expect(toolEnd.result.isError).toBe(true);
			expect(toolEnd.result.content).toContain("not available");
		}
	});

	it("answers a fabricated tool name with a suggestion, not a bare Unknown tool", async () => {
		// Models trained on other harnesses invent names cast doesn't have.
		// A bare "Unknown tool" gave no guidance and the model retried it until
		// the doom-loop guard tripped. The wrapper names the closest real tool.
		const events: AgentEvent[] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t1", name: "globby", arguments: JSON.stringify({ pattern: "**/*.md" }) }],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "find the docs" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "SYS",
			onEvent: (e) => events.push(e),
		});

		const toolEnd = events.find((e) => e.type === "tool_end");
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_end") {
			expect(toolEnd.result.isError).toBe(true);
			expect(toolEnd.result.content).toContain('Unknown tool "globby"');
			expect(toolEnd.result.content).toContain('Did you mean "glob"');
			expect(toolEnd.result.content).toContain("Available tools:");
		}
	});

	it("ends the run after a successful plan_done — the model can't keep the turn alive", async () => {
		// Regression: plan_done is a terminal signal tool. The model used to loop
		// forever calling it with a slightly reworded summary each time (which
		// also slipped past the doom-loop detector, keyed on exact args), so the
		// run never settled and the approval dialog never opened. The loop now
		// ends the turn itself once plan_done succeeds. streamAndCollect is
		// mocked to ALWAYS emit another plan_done, so a passing test proves the
		// loop stopped on its own rather than because the model happened to stop.
		const dir = mkdtempSync(join(tmpdir(), "cast-plan-done-stop-"));
		writeFileSync(join(dir, "feature.md"), "# Plan\n\n## Steps\n1. Do it", "utf-8");
		try {
			let calls = 0;
			vi.mocked(streamAndCollect).mockImplementation(async () => {
				calls++;
				return {
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [
						{
							id: `t${calls}`,
							name: "plan_done",
							arguments: JSON.stringify({ summary: `summary variant ${calls}` }),
						},
					],
				};
			});

			const events: AgentEvent[] = [];
			await runAgentLoop([{ role: "user", content: "finish the plan" }], {
				config: testConfig,
				model: "test-model",
				cwd: "/tmp",
				systemPrompt: "BASE",
				planState: { enabled: true, plansDir: dir },
				onEvent: (e) => events.push(e),
			});

			// Exactly one model request: the loop stopped right after the first
			// successful plan_done instead of asking the model for a next step.
			expect(calls).toBe(1);
			const endEvents = events.filter((e) => e.type === "end");
			expect(endEvents).toHaveLength(1);
			expect(endEvents[0]).toEqual({ type: "end", reason: "stop" });
			// The tool result is in the transcript (no dangling tool_call), and it
			// carries the ready signal rather than an error.
			const toolEnd = events.find((e) => e.type === "tool_end" && e.name === "plan_done");
			expect(toolEnd?.type === "tool_end" && toolEnd.result.isError).toBeFalsy();
		} finally {
			// This test installs a persistent mockImplementation (not Once); the
			// suite's beforeEach only mockClear()s, so reset it here to keep it
			// from bleeding into later tests.
			vi.mocked(streamAndCollect).mockReset();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ============================================================================
// runAgentLoop — open-work gate (turn-end continuation)
// ============================================================================

describe("runAgentLoop — open-work gate", () => {
	const openPlan = "# Plan\n\n## Steps\n- [ ] do the work\n- [ ] verify\n";

	it("nudges on content-only stop when build mode has open checklist steps", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-owg-nudge-"));
		writeFileSync(join(dir, "feature.md"), openPlan, "utf-8");
		try {
			let secondCallMessages: Message[] | undefined;
			vi.mocked(streamAndCollect)
				.mockImplementationOnce(async () => ({
					content: "I'll stop early.",
					thinking: "",
					finishReason: "stop",
				}))
				.mockImplementationOnce(async (_c, _m, msgs) => {
					secondCallMessages = msgs as Message[];
					return {
						content: "",
						thinking: "",
						finishReason: "stop",
						toolCalls: [
							{
								id: "t1",
								name: "plan_check",
								arguments: JSON.stringify({ item: "do the work" }),
							},
							{
								id: "t2",
								name: "plan_check",
								arguments: JSON.stringify({ item: "verify" }),
							},
						],
					};
				})
				.mockImplementationOnce(async () => ({
					content: "done after tools",
					thinking: "",
					finishReason: "stop",
				}));

			const events: AgentEvent[] = [];
			await runAgentLoop([{ role: "user", content: "implement" }], {
				config: testConfig,
				model: "test-model",
				cwd: dir,
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				onEvent: (e) => events.push(e),
			});

			const gateEvents = events.filter((e) => e.type === "open_work_gate");
			expect(gateEvents).toHaveLength(1);
			expect(gateEvents[0]).toMatchObject({ type: "open_work_gate", fires: 1, openSteps: 2 });
			expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(3);
			// applyCacheControl may rewrite user content to a text-part array before
			// the next request — flatten before asserting on the reminder body.
			const reminderText = (secondCallMessages ?? [])
				.filter((m) => m.role === "user")
				.map((m) => contentToText(m.content))
				.find((t) => t.includes("outstanding plan steps"));
			expect(reminderText).toBeDefined();
			expect(reminderText).toContain("<system-reminder>");
			expect(reminderText).toContain("do the work");
		} finally {
			vi.mocked(streamAndCollect).mockReset();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("caps at max fires then emits open_work_gate_exhausted and stops", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-owg-cap-"));
		writeFileSync(join(dir, "feature.md"), openPlan, "utf-8");
		try {
			let calls = 0;
			vi.mocked(streamAndCollect).mockImplementation(async () => {
				calls++;
				return { content: `text-only ${calls}`, thinking: "", finishReason: "stop" };
			});

			const events: AgentEvent[] = [];
			await runAgentLoop([{ role: "user", content: "implement" }], {
				config: testConfig,
				model: "test-model",
				cwd: dir,
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				onEvent: (e) => events.push(e),
			});

			const gates = events.filter((e) => e.type === "open_work_gate");
			const exhausted = events.filter((e) => e.type === "open_work_gate_exhausted");
			expect(gates).toHaveLength(2);
			expect(exhausted).toHaveLength(1);
			expect(exhausted[0]).toMatchObject({ type: "open_work_gate_exhausted", maxFires: 2, openSteps: 2 });
			// 1 initial + 2 gate continues + stop after exhaust (no 4th forced call)
			expect(calls).toBe(3);
			expect(events.filter((e) => e.type === "end")).toEqual([{ type: "end", reason: "stop" }]);
		} finally {
			vi.mocked(streamAndCollect).mockReset();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not fire when all checklist items are done", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-owg-empty-"));
		writeFileSync(join(dir, "feature.md"), "# Plan\n\n## Steps\n- [x] done already\n", "utf-8");
		try {
			vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
				content: "all done",
				thinking: "",
				finishReason: "stop",
			}));

			const events: AgentEvent[] = [];
			await runAgentLoop([{ role: "user", content: "status" }], {
				config: testConfig,
				model: "test-model",
				cwd: dir,
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				onEvent: (e) => events.push(e),
			});

			expect(events.filter((e) => e.type === "open_work_gate")).toHaveLength(0);
			expect(events.filter((e) => e.type === "open_work_gate_exhausted")).toHaveLength(0);
			expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(1);
			expect(events.find((e) => e.type === "end")).toEqual({ type: "end", reason: "stop" });
		} finally {
			vi.mocked(streamAndCollect).mockReset();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not fire in plan mode even with open steps", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-owg-planmode-"));
		writeFileSync(join(dir, "feature.md"), openPlan, "utf-8");
		try {
			vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
				content: "planning",
				thinking: "",
				finishReason: "stop",
			}));

			const events: AgentEvent[] = [];
			await runAgentLoop([{ role: "user", content: "plan it" }], {
				config: testConfig,
				model: "test-model",
				cwd: dir,
				systemPrompt: "BASE",
				planState: { enabled: true, plansDir: dir },
				onEvent: (e) => events.push(e),
			});

			expect(events.filter((e) => e.type === "open_work_gate")).toHaveLength(0);
			expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(1);
		} finally {
			vi.mocked(streamAndCollect).mockReset();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not fire when there is no active plan on disk", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-owg-noplan-"));
		try {
			vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
				content: "ok",
				thinking: "",
				finishReason: "stop",
			}));

			const events: AgentEvent[] = [];
			await runAgentLoop([{ role: "user", content: "hi" }], {
				config: testConfig,
				model: "test-model",
				cwd: dir,
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				onEvent: (e) => events.push(e),
			});

			expect(events.filter((e) => e.type === "open_work_gate")).toHaveLength(0);
			expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(1);
		} finally {
			vi.mocked(streamAndCollect).mockReset();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fires for ### heading steps under ## Steps (no checklist)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-owg-heading-"));
		writeFileSync(join(dir, "feature.md"), "# Plan\n\n## Steps\n\n### Implement stub\n\n### Verify\n", "utf-8");
		try {
			vi.mocked(streamAndCollect)
				.mockImplementationOnce(async () => ({
					content: "stopping",
					thinking: "",
					finishReason: "stop",
				}))
				.mockImplementationOnce(async () => ({
					content: "ok",
					thinking: "",
					finishReason: "stop",
				}));

			const events: AgentEvent[] = [];
			await runAgentLoop([{ role: "user", content: "go" }], {
				config: testConfig,
				model: "test-model",
				cwd: dir,
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				// Cap at 1 so we don't need three content-only turns.
				openWorkGate: { maxFiresPerPrompt: 1 },
				onEvent: (e) => events.push(e),
			});

			expect(events.filter((e) => e.type === "open_work_gate")).toHaveLength(1);
			expect(events.some((e) => e.type === "open_work_gate_exhausted")).toBe(true);
		} finally {
			vi.mocked(streamAndCollect).mockReset();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not run the gate after a successful terminal tool", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-owg-terminal-"));
		writeFileSync(join(dir, "feature.md"), openPlan, "utf-8");
		try {
			let calls = 0;
			vi.mocked(streamAndCollect).mockImplementation(async () => {
				calls++;
				return {
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [
						{
							id: `t${calls}`,
							name: "plan_enter",
							arguments: JSON.stringify({ reason: "switch to plan" }),
						},
					],
				};
			});

			const events: AgentEvent[] = [];
			await runAgentLoop([{ role: "user", content: "switch" }], {
				config: testConfig,
				model: "test-model",
				cwd: dir,
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				onEvent: (e) => events.push(e),
			});

			expect(calls).toBe(1);
			expect(events.filter((e) => e.type === "open_work_gate")).toHaveLength(0);
			expect(events.find((e) => e.type === "end")).toEqual({ type: "end", reason: "stop" });
		} finally {
			vi.mocked(streamAndCollect).mockReset();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resets the fire counter after a follow-up inject", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-owg-followup-"));
		writeFileSync(join(dir, "feature.md"), openPlan, "utf-8");
		const followUpQueue = new MessageQueue();
		try {
			let calls = 0;
			vi.mocked(streamAndCollect).mockImplementation(async () => {
				calls++;
				// After the first outer cycle exhausts (3 content-only turns),
				// the follow-up already queued below restarts a fresh cycle.
				if (calls === 1) {
					followUpQueue.enqueue({ role: "user", content: "please continue" });
				}
				return { content: `text ${calls}`, thinking: "", finishReason: "stop" };
			});

			const events: AgentEvent[] = [];
			await runAgentLoop([{ role: "user", content: "implement" }], {
				config: testConfig,
				model: "test-model",
				cwd: dir,
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				followUpQueue,
				onEvent: (e) => events.push(e),
			});

			expect(events.some((e) => e.type === "followup_injected")).toBe(true);
			const gates = events.filter((e) => e.type === "open_work_gate");
			// First prompt: fires 1+2; after follow-up reset: fire 1 (+ maybe 2)
			expect(gates.length).toBeGreaterThanOrEqual(3);
			expect(gates.filter((e) => e.type === "open_work_gate" && e.fires === 1).length).toBeGreaterThanOrEqual(2);
			expect(events.filter((e) => e.type === "open_work_gate_exhausted").length).toBeGreaterThanOrEqual(2);
		} finally {
			vi.mocked(streamAndCollect).mockReset();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("re-reads the plan after plan_check clears the last open item", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-owg-check-"));
		writeFileSync(join(dir, "feature.md"), "# Plan\n\n## Steps\n- [ ] only step\n", "utf-8");
		try {
			vi.mocked(streamAndCollect)
				.mockImplementationOnce(async () => ({
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [
						{
							id: "t1",
							name: "plan_check",
							arguments: JSON.stringify({ item: "only step" }),
						},
					],
				}))
				.mockImplementationOnce(async () => ({
					content: "finished",
					thinking: "",
					finishReason: "stop",
				}));

			const events: AgentEvent[] = [];
			await runAgentLoop([{ role: "user", content: "finish" }], {
				config: testConfig,
				model: "test-model",
				cwd: dir,
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				onEvent: (e) => events.push(e),
			});

			expect(events.filter((e) => e.type === "open_work_gate")).toHaveLength(0);
			expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(2);
			expect(events.find((e) => e.type === "end")).toEqual({ type: "end", reason: "stop" });
		} finally {
			vi.mocked(streamAndCollect).mockReset();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ============================================================================
// compactSessionMessages — plan-mode extra instructions
// ============================================================================

describe("compactSessionMessages — extraInstructions", () => {
	// Enough alternating turns that compactMessages finds a safe cut point.
	const history = (): Message[] =>
		Array.from({ length: 10 }, (_, i): Message[] => [
			{ role: "user", content: `question ${i}` },
			{ role: "assistant", content: `answer ${i}` },
		]).flat();

	it("appends the plan-mode compaction guidance to the summarization prompt", async () => {
		let promptText = "";
		vi.mocked(streamAndCollect).mockImplementationOnce(
			async (_client: unknown, _model: string, messages: unknown) => {
				promptText = contentToText((messages as Message[])[1]!.content);
				return { content: "summary", thinking: "", finishReason: "stop" };
			},
		);

		const result = await compactSessionMessages(
			history(),
			testConfig,
			"test-model",
			undefined,
			undefined,
			undefined,
			"PLAN_MODE_EXTRA_INSTRUCTIONS",
		);
		expect(result.compacted).toBe(true);
		expect(promptText).toContain("<conversation>");
		expect(promptText.endsWith("PLAN_MODE_EXTRA_INSTRUCTIONS")).toBe(true);
	});

	it("leaves the prompt untouched without extraInstructions", async () => {
		let promptText = "";
		vi.mocked(streamAndCollect).mockImplementationOnce(
			async (_client: unknown, _model: string, messages: unknown) => {
				promptText = contentToText((messages as Message[])[1]!.content);
				return { content: "summary", thinking: "", finishReason: "stop" };
			},
		);

		await compactSessionMessages(history(), testConfig, "test-model");
		expect(promptText).not.toContain("PLAN_MODE_EXTRA_INSTRUCTIONS");
	});

	it("injects a separate trailing user reminder (not inside the summary marker)", async () => {
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
			content: "summary of work",
			thinking: "",
			finishReason: "stop",
		}));

		const result = await compactSessionMessages(
			history(),
			testConfig,
			"test-model",
			undefined,
			undefined,
			undefined,
			undefined,
			{
				mode: "build",
				planName: "ship",
				openSteps: ["wire reminder"],
				openStepsTotal: 1,
			},
		);
		expect(result.compacted).toBe(true);
		const marker = result.messages.find(
			(m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("[Compacted context"),
		);
		expect(marker).toBeDefined();
		expect(marker!.content as string).not.toContain("<system-reminder>");
		expect(marker!.content as string).toContain("summary of work");

		const last = result.messages[result.messages.length - 1]!;
		expect(last.role).toBe("user");
		expect(last.content as string).toContain("<system-reminder>");
		expect(last.content as string).toContain("Active plan: `ship`");
		expect(last.content as string).toContain("## TODO List");
		expect(last.content as string).toContain("- [pending] wire reminder");
	});

	it("omits the reminder when there is no actionable state", async () => {
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
			content: "summary of work",
			thinking: "",
			finishReason: "stop",
		}));

		const result = await compactSessionMessages(history(), testConfig, "test-model");
		expect(result.compacted).toBe(true);
		expect(
			result.messages.some((m) => typeof m.content === "string" && m.content.includes("<system-reminder>")),
		).toBe(false);
	});

	it("surfaces edited files from compacted tool calls in the trailing reminder", async () => {
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
			content: "summary of work",
			thinking: "",
			finishReason: "stop",
		}));

		const withEdits: Message[] = [
			{ role: "system", content: "persona" },
			{ role: "user", content: "fix auth" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "t1",
						type: "function",
						function: { name: "edit", arguments: JSON.stringify({ path: "src/auth.ts" }) },
					},
				],
			},
			{ role: "tool", tool_call_id: "t1", content: "ok" },
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1" },
			{ role: "user", content: "q2" },
			{ role: "assistant", content: "a2" },
			{ role: "user", content: "q3" },
			{ role: "assistant", content: "a3" },
		];

		const result = await compactSessionMessages(withEdits, testConfig, "test-model");
		expect(result.compacted).toBe(true);
		const marker = result.messages.find(
			(m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("[Compacted context"),
		);
		expect(marker!.content as string).toContain("<modified-files>");
		expect(marker!.content as string).not.toContain("<system-reminder>");
		const last = result.messages[result.messages.length - 1]!;
		expect(last.role).toBe("user");
		expect(last.content as string).toContain("## Files Edited This Session");
		expect(last.content as string).toContain("src/auth.ts");
	});
});

// ============================================================================
// runAgentLoop — doom loop detection
// ============================================================================

describe("runAgentLoop — doom loop detection", () => {
	it("blocks a tool call after DOOM_LOOP_THRESHOLD identical consecutive calls and emits doom_loop event", async () => {
		const events: AgentEvent[] = [];
		const loopArgs = JSON.stringify({ command: "echo hi" });

		vi.mocked(streamAndCollect)
			// Calls 1, 2, 3: model keeps calling bash with the same args.
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t1", name: "bash", arguments: loopArgs }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t2", name: "bash", arguments: loopArgs }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t3", name: "bash", arguments: loopArgs }],
			}))
			// Call 4: the 4th identical call is blocked by doom loop detection.
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t4", name: "bash", arguments: loopArgs }],
			}))
			// After the doom loop error, model gives up.
			.mockImplementationOnce(async () => ({
				content: "I'll try something different.",
				thinking: "",
				finishReason: "stop",
			}));

		await runAgentLoop([{ role: "user", content: "run it" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			onEvent: (event) => events.push(structuredClone(event)),
		});

		// doom_loop event must have fired exactly once (on the 4th call).
		const doomEvents = events.filter((e) => e.type === "doom_loop");
		expect(doomEvents).toHaveLength(1);
		expect(doomEvents[0]).toEqual({ type: "doom_loop", tool: "bash", attempts: 3 });

		// The blocked tool_end must carry an error result mentioning "Doom loop".
		const toolEnds = events.filter((e) => e.type === "tool_end");
		const blockedEnd = toolEnds.find((e) => e.type === "tool_end" && e.id === "t4");
		expect(blockedEnd).toBeDefined();
		if (blockedEnd && blockedEnd.type === "tool_end") {
			expect(blockedEnd.result.isError).toBe(true);
			expect(blockedEnd.result.content).toContain("Doom loop detected");
		}

		expect(events.find((e) => e.type === "end")).toEqual({ type: "end", reason: "stop" });
	});

	it("does NOT block when calls alternate between different tools", async () => {
		const events: AgentEvent[] = [];

		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t1", name: "bash", arguments: JSON.stringify({ command: "ls" }) }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t2", name: "read", arguments: JSON.stringify({ path: "foo.ts" }) }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t3", name: "bash", arguments: JSON.stringify({ command: "ls" }) }],
			}))
			.mockImplementationOnce(async () => ({
				content: "done",
				thinking: "",
				finishReason: "stop",
			}));

		await runAgentLoop([{ role: "user", content: "do stuff" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			onEvent: (event) => events.push(structuredClone(event)),
		});

		expect(events.filter((e) => e.type === "doom_loop")).toHaveLength(0);
	});

	it("detects a doom loop inside a single parallel batch (batch not blind to itself)", async () => {
		const events: AgentEvent[] = [];
		const loopArgs = JSON.stringify({ command: "echo hi" });

		vi.mocked(streamAndCollect)
			// One completion, FOUR identical calls in one batch — executed via
			// Promise.all. The sequential pre-scan must let the first three
			// through and block the fourth.
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [
					{ id: "t1", name: "bash", arguments: loopArgs },
					{ id: "t2", name: "bash", arguments: loopArgs },
					{ id: "t3", name: "bash", arguments: loopArgs },
					{ id: "t4", name: "bash", arguments: loopArgs },
				],
			}))
			.mockImplementationOnce(async () => ({
				content: "ok",
				thinking: "",
				finishReason: "stop",
			}));

		await runAgentLoop([{ role: "user", content: "run it" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			onEvent: (event) => events.push(structuredClone(event)),
		});

		expect(events.filter((e) => e.type === "doom_loop")).toHaveLength(1);
		const toolEnds = events.filter((e) => e.type === "tool_end");
		const okEnds = toolEnds.filter((e) => e.type === "tool_end" && ["t1", "t2", "t3"].includes(e.id));
		expect(okEnds).toHaveLength(3);
		expect(okEnds.every((e) => e.type === "tool_end" && !e.result.isError)).toBe(true);
		const blocked = toolEnds.find((e) => e.type === "tool_end" && e.id === "t4");
		expect(blocked && blocked.type === "tool_end" && blocked.result.isError).toBe(true);
		expect(blocked && blocked.type === "tool_end" ? blocked.result.content : "").toContain("Doom loop detected");
	});

	it("resets the window on a follow-up user message — an explicit re-run is not a loop", async () => {
		const events: AgentEvent[] = [];
		const loopArgs = JSON.stringify({ command: "echo hi" });
		const identicalCall = (id: string) => ({
			content: "",
			thinking: "",
			finishReason: "stop" as const,
			toolCalls: [{ id, name: "bash", arguments: loopArgs }],
		});

		vi.mocked(streamAndCollect)
			// Three identical calls fill the window...
			.mockImplementationOnce(async () => identicalCall("t1"))
			.mockImplementationOnce(async () => identicalCall("t2"))
			.mockImplementationOnce(async () => identicalCall("t3"))
			// ...turn ends...
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }))
			// ...follow-up injected (window reset) — the same call must run again.
			.mockImplementationOnce(async () => identicalCall("t5"))
			.mockImplementationOnce(async () => ({ content: "done again", thinking: "", finishReason: "stop" }));

		const followUpQueue = new MessageQueue();
		followUpQueue.enqueue({ role: "user", content: "run it once more" });

		await runAgentLoop([{ role: "user", content: "run it" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			followUpQueue,
			onEvent: (event) => events.push(structuredClone(event)),
		});

		expect(events.filter((e) => e.type === "followup_injected")).toHaveLength(1);
		expect(events.filter((e) => e.type === "doom_loop")).toHaveLength(0);
		const t5 = events.find((e) => e.type === "tool_end" && e.id === "t5");
		expect(t5 && t5.type === "tool_end" && !t5.result.isError).toBe(true);
	});

	it("resets the window on a steering message injected mid-run", async () => {
		const events: AgentEvent[] = [];
		const loopArgs = JSON.stringify({ command: "echo hi" });
		const identicalCall = (id: string) => ({
			content: "",
			thinking: "",
			finishReason: "stop" as const,
			toolCalls: [{ id, name: "bash", arguments: loopArgs }],
		});

		const steeringQueue = new MessageQueue();

		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => identicalCall("t1"))
			.mockImplementationOnce(async () => identicalCall("t2"))
			.mockImplementationOnce(async () => {
				// Window will be [A, A, A] after t3 executes. Queue a steering
				// message; it's injected at the top of the next inner iteration
				// and must clear the window before t4 is checked.
				steeringQueue.enqueue({ role: "user", content: "keep going, run it again" });
				return identicalCall("t3");
			})
			.mockImplementationOnce(async () => identicalCall("t4"))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "run it" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			steeringQueue,
			onEvent: (event) => events.push(structuredClone(event)),
		});

		expect(events.filter((e) => e.type === "steering_injected")).toHaveLength(1);
		expect(events.filter((e) => e.type === "doom_loop")).toHaveLength(0);
		const t4 = events.find((e) => e.type === "tool_end" && e.id === "t4");
		expect(t4 && t4.type === "tool_end" && !t4.result.isError).toBe(true);
	});
});

// ============================================================================
// runAgentLoop — disabledTools filtering
// ============================================================================

type ToolDef = { type: "function"; function: { name: string } };

describe("runAgentLoop — disabledTools filtering", () => {
	it("excludes web_search and web_fetch when disabledTools contains them", async () => {
		let capturedTools: ToolDef[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, _msgs, tools) => {
			capturedTools = tools as ToolDef[];
			return { content: "ok", thinking: "", finishReason: "stop" };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			disabledTools: new Set(["web_search", "web_fetch"]),
			onEvent: () => {},
		});

		const names = capturedTools.map((t) => t.function.name);
		expect(names).toContain("bash");
		expect(names).toContain("read");
		expect(names).not.toContain("web_search");
		expect(names).not.toContain("web_fetch");
	});

	it("includes web_search and web_fetch when disabledTools is empty", async () => {
		let capturedTools: ToolDef[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, _msgs, tools) => {
			capturedTools = tools as ToolDef[];
			return { content: "ok", thinking: "", finishReason: "stop" };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			disabledTools: new Set<string>(),
			onEvent: () => {},
		});

		const names = capturedTools.map((t) => t.function.name);
		expect(names).toContain("web_search");
		expect(names).toContain("web_fetch");
	});

	it("includes web tools when disabledTools is undefined", async () => {
		let capturedTools: ToolDef[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, _msgs, tools) => {
			capturedTools = tools as ToolDef[];
			return { content: "ok", thinking: "", finishReason: "stop" };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			onEvent: () => {},
		});

		const names = capturedTools.map((t) => t.function.name);
		expect(names).toContain("web_search");
		expect(names).toContain("web_fetch");
	});
});

// ============================================================================
// runAgentLoop — allowedTools (persona/subagent frontmatter tools:)
// ============================================================================

describe("runAgentLoop — allowedTools filtering", () => {
	it("advertises only allowlisted tools", async () => {
		let capturedTools: ToolDef[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, _msgs, tools) => {
			capturedTools = tools as ToolDef[];
			return { content: "ok", thinking: "", finishReason: "stop" };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			allowedTools: ["read", "grep"],
			onEvent: () => {},
		});

		const names = capturedTools.map((t) => t.function.name);
		expect(names.sort()).toEqual(["grep", "read"]);
	});

	it("expands plan_* and web_* globs in the allowlist", async () => {
		let capturedTools: ToolDef[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, _msgs, tools) => {
			capturedTools = tools as ToolDef[];
			return { content: "ok", thinking: "", finishReason: "stop" };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			// No disabledTools — globs should surface the full plan_/web_ families.
			allowedTools: ["read", "plan_*", "web_*"],
			onEvent: () => {},
		});

		const names = new Set(capturedTools.map((t) => t.function.name));
		expect(names.has("read")).toBe(true);
		expect(names.has("web_search")).toBe(true);
		expect(names.has("web_fetch")).toBe(true);
		expect(names.has("plan_write")).toBe(true);
		expect(names.has("plan_done")).toBe(true);
		expect(names.has("bash")).toBe(false);
		expect(names.has("write")).toBe(false);
	});

	it("refuses a real call to a tool outside the allowlist", async () => {
		const events: AgentEvent[] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t1", name: "bash", arguments: JSON.stringify({ command: "echo hi" }) }],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "run it" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "SYS",
			allowedTools: ["read", "grep"],
			onEvent: (e) => events.push(e),
		});

		const toolEnd = events.find((e) => e.type === "tool_end");
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_end") {
			expect(toolEnd.result.isError).toBe(true);
			expect(toolEnd.result.content).toContain("not available");
			expect(toolEnd.result.content).not.toContain("Unknown tool");
		}
	});

	it("applies persona.tools when LoopConfig.allowedTools is omitted", async () => {
		let capturedTools: ToolDef[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, _msgs, tools) => {
			capturedTools = tools as ToolDef[];
			return { content: "ok", thinking: "", finishReason: "stop" };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			personas: [
				{
					name: "reviewer",
					label: "Reviewer",
					description: "",
					systemPrompt: "review",
					source: "builtin",
					filePath: "",
					subagents: false,
					tools: ["read", "ls"],
					agentsMd: true,
				},
			],
			currentPersona: "reviewer",
			onEvent: () => {},
		});

		expect(capturedTools.map((t) => t.function.name).sort()).toEqual(["ls", "read"]);
	});

	it("keeps MCP tools available under a builtin-only allowlist", async () => {
		// Persona/subagent `tools:` constrains builtins (read/write/…), not the
		// user's connected MCP servers — those names are session-specific.
		const events: AgentEvent[] = [];
		const mcpCall = vi.fn(async () => ({ content: "MCP_OK", isError: false }));
		const mcpDef = {
			type: "function" as const,
			function: {
				name: "mcp_demo_ping",
				description: "ping",
				parameters: { type: "object", properties: {} },
			},
		};
		let capturedTools: ToolDef[] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async (_c, _m, _msgs, tools) => {
				capturedTools = tools as ToolDef[];
				return {
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [{ id: "t1", name: "mcp_demo_ping", arguments: "{}" }],
				};
			})
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "ping" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "SYS",
			allowedTools: ["read"],
			mcpTools: [mcpDef],
			mcpToolIndex: new Map([["mcp_demo_ping", { definition: mcpDef, call: mcpCall }]]),
			onEvent: (e) => events.push(e),
		});

		const names = capturedTools.map((t) => t.function.name);
		expect(names).toContain("read");
		expect(names).toContain("mcp_demo_ping");
		expect(names).not.toContain("bash");
		expect(mcpCall).toHaveBeenCalledOnce();
		const toolEnd = events.find((e) => e.type === "tool_end");
		expect(toolEnd?.type === "tool_end" && !toolEnd.result.isError).toBe(true);
		if (toolEnd?.type === "tool_end") {
			expect(toolEnd.result.content).toBe("MCP_OK");
		}
	});

	it("intersects allowlist with disabledTools", async () => {
		let capturedTools: ToolDef[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, _msgs, tools) => {
			capturedTools = tools as ToolDef[];
			return { content: "ok", thinking: "", finishReason: "stop" };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			allowedTools: ["read", "bash", "web_search"],
			disabledTools: new Set(["web_search", "bash"]),
			onEvent: () => {},
		});

		expect(capturedTools.map((t) => t.function.name)).toEqual(["read"]);
	});

	it("subagent frontmatter tools: blocks real calls via execTask → runAgentLoop", async () => {
		const { execTask } = await import("../src/core/tools/task.ts");
		const events: AgentEvent[] = [];
		let advertised: string[] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async (_c, _m, _msgs, tools) => {
				advertised = (tools as ToolDef[]).map((t) => t.function.name);
				return {
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [
						{
							id: "t1",
							name: "write",
							arguments: JSON.stringify({ path: "x.ts", content: "nope" }),
						},
					],
				};
			})
			.mockImplementationOnce(async () => ({
				content: "explored without writing",
				thinking: "",
				finishReason: "stop",
			}));

		const result = await execTask({ assignment: "explore only", subagent: "explorer" }, "/tmp", testConfig, {
			model: "test-model",
			subagentPrompts: [
				{
					name: "explorer",
					label: "Explorer",
					description: "read-only",
					systemPrompt: "Explore.",
					tools: ["read", "grep", "ls"],
					agentsMd: false,
				},
			],
			runAgentLoop: async (messages, config) => {
				const withEvents: typeof config = {
					...config,
					onEvent: (e) => {
						events.push(e);
						config.onEvent(e);
					},
				};
				return runAgentLoop(messages, withEvents);
			},
		});

		expect(result.isError).toBeFalsy();
		expect(advertised.sort()).toEqual(["grep", "ls", "read"]);
		const toolEnd = events.find((e) => e.type === "tool_end");
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_end") {
			expect(toolEnd.result.isError).toBe(true);
			expect(toolEnd.result.content).toContain("not available");
		}
	});
});
