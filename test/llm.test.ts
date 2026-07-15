import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import {
	describeTurnError,
	EMPTY_ASSISTANT_PLACEHOLDER,
	isRetryableStreamError,
	parseHermesToolCalls,
	streamAndCollect,
	streamChat,
	stripHermesToolCalls,
} from "../src/core/llm.ts";

function fakeClient(chunks: unknown[], onChunk?: () => void): OpenAI {
	return {
		chat: {
			completions: {
				create: async () => ({
					async *[Symbol.asyncIterator]() {
						for (const chunk of chunks) {
							yield chunk;
							onChunk?.();
						}
					},
				}),
			},
		},
	} as unknown as OpenAI;
}

// APIError.makeMessage only falls back to the 3rd constructor arg when
// `error` itself is falsy — an empty-but-truthy `{}` body wins instead and
// produces "429 {}", not the intended text. Put `message` inside the body,
// matching how a real `{"error": {"message": ..., "code": ...}}` JSON
// response actually shapes it.
function rateLimitError(body: Record<string, unknown>) {
	return new OpenAI.RateLimitError(429, body, undefined, {} as never);
}

describe("parseHermesToolCalls / stripHermesToolCalls", () => {
	it("parses a Hermes XML call into a proper tool call with JSON arguments", () => {
		const content = "<tool_call>\n<function=search_tasks>\n<parameter=status>in_progress</parameter>\n</function>\n</tool_call>";
		const calls = parseHermesToolCalls(content);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.name).toBe("search_tasks");
		expect(JSON.parse(calls[0]!.arguments)).toEqual({ status: "in_progress" });
	});

	it("coerces None/null/booleans/numbers, leaves free text as strings", () => {
		const content =
			"<function=f><parameter=a>None</parameter><parameter=b>true</parameter><parameter=c>42</parameter><parameter=d>hello world</parameter></function>";
		expect(JSON.parse(parseHermesToolCalls(content)[0]!.arguments)).toEqual({
			a: null,
			b: true,
			c: 42,
			d: "hello world",
		});
	});

	it("returns [] when there is no Hermes block", () => {
		expect(parseHermesToolCalls("just a normal answer, no calls")).toEqual([]);
	});

	it("strips the XML block (and tool_call wrapper) from visible content", () => {
		const content = "before <tool_call><function=f><parameter=x>1</parameter></function></tool_call> after";
		expect(stripHermesToolCalls(content)).toBe("before  after");
	});
});

describe("streamAndCollect — Hermes tool-call recovery", () => {
	it("recovers a valid tool call when the provider emits XML content + truncated arguments", async () => {
		// The exact failure shape from xiaomi mimo: the call leaks into content as
		// Hermes XML while tool_calls.arguments arrives as truncated, invalid JSON.
		const client = fakeClient([
			{
				choices: [
					{ delta: { content: "<tool_call>\n<function=search_tasks>\n<parameter=status>in_progress</parameter>\n</function>\n</tool_call>" } },
				],
			},
			{
				choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "search_tasks", arguments: '{"memberId": ' } }] } }],
			},
			{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
		]);
		const res = await streamAndCollect(client, "m", [], [], 100);
		expect(res.toolCalls).toHaveLength(1);
		expect(res.toolCalls![0]!.name).toBe("search_tasks");
		// Arguments are now valid JSON (were truncated before recovery).
		expect(() => JSON.parse(res.toolCalls![0]!.arguments)).not.toThrow();
		expect(JSON.parse(res.toolCalls![0]!.arguments)).toEqual({ status: "in_progress" });
		// The XML markup is stripped from what the user sees.
		expect(res.content).not.toContain("<function=");
	});

	it("leaves well-formed tool_calls untouched (no false recovery)", async () => {
		const client = fakeClient([
			{ choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "read", arguments: '{"path":"a.ts"}' } }] } }] },
			{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
		]);
		const res = await streamAndCollect(client, "m", [], [], 100);
		expect(res.toolCalls).toHaveLength(1);
		expect(res.toolCalls![0]!.id).toBe("t1");
		expect(JSON.parse(res.toolCalls![0]!.arguments)).toEqual({ path: "a.ts" });
	});
});

describe("isRetryableStreamError", () => {
	it("retries a generic rate-limit error", () => {
		expect(isRetryableStreamError(rateLimitError({ message: "Rate limit reached, please try again later." }))).toBe(
			true,
		);
	});

	it("does not retry OpenAI's insufficient_quota code", () => {
		expect(
			isRetryableStreamError(
				rateLimitError({
					code: "insufficient_quota",
					message: "You exceeded your current quota, please check billing.",
				}),
			),
		).toBe(false);
	});

	it("does not retry a quota-exhaustion message even without the code field", () => {
		// Some OpenAI-compatible gateways surface quota exhaustion as a 429
		// without setting a machine-readable `code` — only the wording says so.
		expect(isRetryableStreamError(rateLimitError({ message: "quota exceeded for this billing period" }))).toBe(false);
	});

	it("retries network-level transient errors", () => {
		expect(isRetryableStreamError(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }))).toBe(true);
		expect(isRetryableStreamError(new Error("socket hang up"))).toBe(true);
	});

	it("does not retry a user-initiated abort", () => {
		expect(isRetryableStreamError(new OpenAI.APIUserAbortError())).toBe(false);
	});

	it("does not retry an unrelated error", () => {
		expect(isRetryableStreamError(new Error("something unrelated"))).toBe(false);
	});
});

describe("streamAndCollect — usage accounting", () => {
	it("recomputes totalTokens instead of trusting a mismatched raw total_tokens", async () => {
		// A real OpenAI-compatible gateway reporting an internally inconsistent
		// total_tokens (999, matching neither prompt+completion nor anything
		// else) shouldn't leak into what we show the user — see llm.ts's
		// comment on this for why pi's own reference implementation does the
		// same recompute instead of trusting the raw field.
		const client = fakeClient([
			{ choices: [{ delta: { content: "hi" } }] },
			{
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 999 },
			},
		]);
		const result = await streamAndCollect(client, "test-model", [], [], 100);
		expect(result.usage?.totalTokens).toBe(120);
	});

	it("treats prompt_tokens_details.cached_tokens as a subset of prompt_tokens, not additional to it", async () => {
		const client = fakeClient([
			{ choices: [{ delta: { content: "hi" } }] },
			{
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 20,
					total_tokens: 120,
					prompt_tokens_details: { cached_tokens: 80 },
				},
			},
		]);
		const result = await streamAndCollect(client, "test-model", [], [], 100);
		expect(result.usage?.cacheReadTokens).toBe(80);
		// Cache hit % = cacheReadTokens / promptTokens must stay within [0, 100] —
		// it would exceed that if cached_tokens were additional to prompt_tokens
		// instead of a breakdown within it.
		const cacheHitPct = (result.usage!.cacheReadTokens! / result.usage!.promptTokens) * 100;
		expect(cacheHitPct).toBeGreaterThanOrEqual(0);
		expect(cacheHitPct).toBeLessThanOrEqual(100);
		expect(cacheHitPct).toBe(80);
	});

	it("computes generationMs from the first streamed chunk to the last", async () => {
		vi.useFakeTimers();
		try {
			const client = fakeClient(
				[
					{ choices: [{ delta: { content: "a" } }] },
					{ choices: [{ delta: { content: "b" } }] },
					{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
				],
				() => vi.advanceTimersByTime(500),
			);
			const result = await streamAndCollect(client, "test-model", [], [], 100);
			// Now measures from first chunk to stream exhaustion (done), matching
			// opencode's tsLastByte-on-done pattern. The fake client advances
			// 500ms per read() including the final done-read, so: firstChunk at
			// 500ms, Date.now() after loop at 2000ms -> 1500ms.
			expect(result.generationMs).toBe(1500);
		} finally {
			vi.useRealTimers();
		}
	});

	it("leaves generationMs undefined when nothing ever streamed", async () => {
		const client = fakeClient([]);
		const result = await streamAndCollect(client, "test-model", [], [], 100);
		expect(result.generationMs).toBeUndefined();
	});

	it("captures delta.reasoning_content (DeepSeek/Qwen/MiMo) into thinking", async () => {
		// These providers expose no reasoning metadata via /v1/models and stream
		// their reasoning in reasoning_content, not `reasoning` or <think> tags —
		// so this is the only signal we get that they reasoned at all.
		const client = fakeClient([
			{ choices: [{ delta: { reasoning_content: "let me think " } }] },
			{ choices: [{ delta: { reasoning_content: "step by step" } }] },
			{ choices: [{ delta: { content: "the answer is 42" } }] },
			{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 4 } },
		]);
		const result = await streamAndCollect(client, "test-model", [], [], 100);
		expect(result.thinking).toBe("let me think step by step");
		expect(result.content).toBe("the answer is 42");
	});

	it("prefers delta.reasoning over reasoning_content when a provider sends both", async () => {
		const client = fakeClient([
			{ choices: [{ delta: { reasoning: "openrouter-style", reasoning_content: "should be ignored" } }] },
			{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
		]);
		const result = await streamAndCollect(client, "test-model", [], [], 100);
		expect(result.thinking).toBe("openrouter-style");
	});
});

describe("streamAndCollect — interrupted / disconnected flags", () => {
	// These run the REAL streamAndCollect over fake chunk streams (not a mock),
	// so they actually exercise the sawFinish / usage detection the loop relies on.

	it("flags disconnected when the stream ends with no finish_reason and no usage", async () => {
		// Provider dropped mid-response: some content, then the stream just ends.
		const client = fakeClient([{ choices: [{ delta: { content: "half an ans" } }] }]);
		const result = await streamAndCollect(client, "m", [], [], 100);
		expect(result.disconnected).toBe(true);
		expect(result.interrupted).toBeFalsy();
	});

	it("does NOT flag disconnected when a finish_reason arrived", async () => {
		const client = fakeClient([
			{ choices: [{ delta: { content: "hi" } }] },
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
		]);
		const result = await streamAndCollect(client, "m", [], [], 100);
		expect(result.disconnected).toBeFalsy();
	});

	it("does NOT flag disconnected when usage arrived without a finish_reason", async () => {
		// A provider that omits finish_reason but sends a terminal usage chunk on a
		// genuinely complete turn (the false-positive guard) — must not be flagged.
		const client = fakeClient([
			{ choices: [{ delta: { content: "hi" } }] },
			{ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
		]);
		const result = await streamAndCollect(client, "m", [], [], 100);
		expect(result.disconnected).toBe(false);
	});

	it("flags interrupted (not disconnected) when the signal is aborted mid-stream with no finish", async () => {
		const controller = new AbortController();
		const client = fakeClient(
			[{ choices: [{ delta: { content: "part" } }] }],
			// Abort right after the chunk streams, before any finish_reason.
			() => controller.abort(),
		);
		const result = await streamAndCollect(client, "m", [], [], 100, controller.signal);
		expect(result.interrupted).toBe(true);
		expect(result.disconnected).toBe(false);
	});
});

describe("streamChat — message sanitization", () => {
	function capturingClient(): { client: OpenAI; sent: () => unknown[] } {
		let captured: unknown[] = [];
		const client = {
			chat: {
				completions: {
					create: async (params: { messages: unknown[] }) => {
						captured = params.messages;
						return {
							async *[Symbol.asyncIterator]() {
								yield { choices: [{ delta: {}, finish_reason: "stop" }] };
							},
						};
					},
				},
			},
		} as unknown as OpenAI;
		return { client, sent: () => captured };
	}

	it("replaces a null-content assistant message (no tool_calls) with a placeholder", async () => {
		const { client, sent } = capturingClient();
		const messages = [
			{ role: "user", content: "hi" },
			// A turn that streamed only reasoning persists like this and, sent
			// back as-is, makes GLM/z.ai answer 400 Param Incorrect.
			{ role: "assistant", content: null },
			{ role: "user", content: "продолжи" },
		];
		for await (const _ of streamChat(client, "m", messages as never, [], 100)) {
			// drain
		}
		const outAssistant = sent()[1] as { content: string };
		expect(outAssistant.content).toBe(EMPTY_ASSISTANT_PLACEHOLDER);
	});

	it("leaves an assistant message with tool_calls untouched despite null content", async () => {
		const { client, sent } = capturingClient();
		const toolMsg = {
			role: "assistant",
			content: null,
			tool_calls: [{ id: "1", type: "function", function: { name: "read", arguments: "{}" } }],
		};
		for await (const _ of streamChat(client, "m", [toolMsg] as never, [], 100)) {
			// drain
		}
		expect((sent()[0] as { content: unknown }).content).toBeNull();
	});

	it("fixes truncated tool call arguments in loaded sessions", async () => {
		const { client, sent } = capturingClient();
		const toolMsg = {
			role: "assistant",
			content: [{ type: "text", text: "Writing file..." }],
			tool_calls: [
				{
					id: "call_1",
					type: "function",
					function: { name: "write", arguments: '{"path": "/some/file.md", "content": "# truncated' },
				},
			],
		};
		const toolResult = { role: "tool", tool_call_id: "call_1", content: "EISDIR: illegal operation on a directory" };
		for await (const _ of streamChat(client, "m", [toolMsg, toolResult] as never, [], 100)) {
			// drain
		}
		const outToolCalls = (sent()[0] as { tool_calls: Array<{ function: { arguments: string } }> }).tool_calls;
		const parsed = JSON.parse(outToolCalls[0].function.arguments);
		expect(parsed.error).toContain("truncated");
	});
});

describe("describeTurnError", () => {
	// A body-less gateway 401 (the mimo case): status set, message terse.
	it("maps a 401 (by status) to a revoked-key message pointing at /provider", () => {
		const err = Object.assign(new Error("401 status code (no body)"), { status: 401 });
		const out = describeTurnError(err);
		expect(out).toContain("401");
		expect(out).toContain("/provider");
		expect(out.toLowerCase()).toContain("revoked");
	});

	it("maps a 401 by wording when no status is attached (wrapped error)", () => {
		const out = describeTurnError(new Error("Unauthorized: invalid api key"));
		expect(out).toContain("/provider");
	});

	it("maps a 403 to an access-denied message", () => {
		const err = Object.assign(new Error("403 Forbidden"), { status: 403 });
		const out = describeTurnError(err);
		expect(out).toContain("403");
		expect(out.toLowerCase()).toContain("permission");
	});

	it("maps quota exhaustion (429 insufficient_quota) to a billing message, not a key error", () => {
		const err = Object.assign(new Error("429 You exceeded your current quota"), {
			status: 429,
			code: "insufficient_quota",
		});
		const out = describeTurnError(err);
		expect(out.toLowerCase()).toContain("quota");
		expect(out).not.toContain("401");
	});

	it("passes an unrecognized error through unchanged", () => {
		const out = describeTurnError(new Error("some other failure"));
		expect(out).toBe("some other failure");
	});
});
