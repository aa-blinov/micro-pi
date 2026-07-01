import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import type { Message } from "../src/core/llm.ts";

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

const { runAgentLoop, MessageQueue } = await import("../src/core/loop.ts");
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
