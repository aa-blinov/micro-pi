import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { isRetryableStreamError, streamAndCollect } from "../src/core/llm.ts";

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
