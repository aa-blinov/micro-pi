import OpenAI, {
	APIConnectionError,
	APIConnectionTimeoutError,
	APIUserAbortError,
	InternalServerError,
	RateLimitError,
} from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { AppConfig } from "./config.ts";
import { ThinkBlockParser } from "./vendors.ts";

export type Message = ChatCompletionMessageParam;
export type Tool = ChatCompletionTool;

export function createClient(config: AppConfig): OpenAI {
	// The SDK's bundled node-fetch shim can turn a stream that dies mid-flight
	// into an *uncaught* "Premature close" exception instead of a rejection our
	// retry logic can catch (confirmed by testing against a server that cuts
	// the connection after headers). Node's native fetch doesn't have that
	// failure mode, so use it explicitly rather than relying on the shim.
	return new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey, fetch: globalThis.fetch });
}

export interface Usage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	/** Real cost in USD, when the provider reports one (e.g. OpenRouter) — not universal. */
	cost?: number;
	/** Tokens served from provider's prompt cache (cache hit). */
	cacheReadTokens?: number;
	/** Tokens written to provider's prompt cache (cache miss / new entry). */
	cacheWriteTokens?: number;
	/** Input tokens that were neither cached read nor cached write (full price). */
	uncachedTokens?: number;
}

export interface StreamChunk {
	content?: string;
	thinking?: string;
	toolCalls?: Array<{
		id: string;
		name: string;
		arguments: string;
	}>;
	finishReason?: string;
	/** Emitted instead of a real chunk when a transient error is about to be retried. */
	retrying?: { attempt: number; maxAttempts: number; reason: string };
	/** Present on the final chunk when the provider honors `stream_options.include_usage`. */
	usage?: Usage;
}

// ============================================================================
// Retry — the OpenAI SDK already retries 429/5xx/connection failures at the
// initial-request level (before any bytes of the stream are read). What it
// doesn't cover is a stream dying mid-flight (the provider or a proxy just
// cuts the connection after some chunks already arrived). We only retry that
// case if nothing has been yielded yet in the *current* attempt — once real
// tokens have reached the caller (and likely been printed), restarting from
// scratch would duplicate output, so a later failure is surfaced as-is.
// ============================================================================

const MAX_STREAM_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

// Quota/billing exhaustion surfaces as the exact same 429 RateLimitError as a
// transient "too many requests" — the SDK doesn't distinguish them by class,
// only by the error body's `code` (OpenAI's `insufficient_quota`) or wording
// (gateways vary). Retrying it wastes MAX_STREAM_RETRIES attempts on
// something that won't resolve until the account's quota/billing changes.
const NON_RETRYABLE_QUOTA_PATTERN = /insufficient_quota|quota exceeded|out of budget|billing/i;

// Context overflow detection — borrowed from opencode's llm/provider-error.ts.
// Matches every provider's wording when the conversation exceeds the model's
// context window. Used to trigger auto-compaction instead of surfacing a raw
// error to the user.
const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
	/prompt is too long/i,
	/input is too long for requested model/i,
	/exceeds the context window/i,
	/input token count.*exceeds the maximum/i,
	/maximum prompt length is \d+/i,
	/reduce the length of the messages/i,
	/maximum context length is \d+ tokens/i,
	/exceeds the limit of \d+/i,
	/exceeds the available context size/i,
	/greater than the context length/i,
	/context window exceeds limit/i,
	/exceeded model token limit/i,
	/context[_ ]length[_ ]exceeded/i,
	/request entity too large/i,
	/context length is only \d+ tokens/i,
	/input length.*exceeds.*context length/i,
	/prompt too long; exceeded (?:max )?context length/i,
	/too large for model with \d+ maximum context length/i,
	/model_context_window_exceeded/i,
];

export function isContextOverflow(error: unknown): boolean {
	const code = (error as { code?: string } | undefined)?.code;
	if (code === "context_length_exceeded") return true;
	const status = (error as { status?: number } | undefined)?.status;
	if (status === 413) return true;
	const message = error instanceof Error ? error.message : String(error);
	if (CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(message))) return true;
	if (/^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message)) return true;
	return false;
}

/**
 * Also used outside this module (see index.ts) to recognize this same class
 * of error when it escapes as an uncaught exception instead of a rejection —
 * confirmed by testing that a connection dying mid-stream *after* some
 * content already arrived can throw from deep inside undici with no pending
 * read to reject, bypassing this file's own try/catch entirely.
 */
export function isRetryableStreamError(error: unknown): boolean {
	if (error instanceof APIUserAbortError) return false;

	const code = (error as { code?: string } | undefined)?.code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "insufficient_quota" || NON_RETRYABLE_QUOTA_PATTERN.test(message)) return false;

	if (
		error instanceof RateLimitError ||
		error instanceof InternalServerError ||
		error instanceof APIConnectionTimeoutError ||
		error instanceof APIConnectionError
	) {
		return true;
	}

	if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EPIPE" || code === "UND_ERR_SOCKET") return true;

	return /terminated|socket hang up|other side closed|fetch failed/i.test(message);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stream chat completions with vendor-agnostic thinking support.
 */
export async function* streamChat(
	client: OpenAI,
	model: string,
	messages: Message[],
	tools: Tool[],
	maxTokens: number,
	signal?: AbortSignal,
	reasoningBody: Record<string, unknown> = {},
): AsyncGenerator<StreamChunk> {
	const params: OpenAI.ChatCompletionCreateParamsStreaming = {
		model,
		messages,
		tools: tools.length > 0 ? tools : undefined,
		max_tokens: maxTokens,
		stream: true,
		// Standard OpenAI-compatible field for getting token counts on a
		// streaming response (delivered on a final chunk with empty choices).
		// Providers that don't understand it just ignore the extra key.
		stream_options: { include_usage: true },
	};

	// Merge vendor-specific reasoning parameters
	if (Object.keys(reasoningBody).length > 0) {
		Object.assign(params, reasoningBody);
	}

	let attempt = 0;
	let yieldedAny = false;

	while (true) {
		try {
			const stream = await client.chat.completions.create(params, { signal });

			const toolCallAccumulator = new Map<number, { id: string; name: string; arguments: string }>();
			const thinkParser = new ThinkBlockParser();

			for await (const chunk of stream) {
				const result: StreamChunk = {};

				// Usage arrives on its own trailing chunk with empty `choices` for
				// some providers, and alongside the final content delta for others —
				// check it before the no-delta early exit below so neither shape is missed.
				if (chunk.usage) {
					const usageAny = chunk.usage as unknown as Record<string, unknown>;
					const promptTokensDetails = usageAny.prompt_tokens_details as
						| { cached_tokens?: number; cache_write_tokens?: number }
						| undefined;
					// Universal cache token extraction — covers:
					//   1. OpenAI/vLLM:       prompt_tokens_details.cached_tokens
					//   2. OpenRouter/Anthropic: prompt_cache_hit_tokens
					//   3. Native Anthropic:  cache_read_input_tokens / cache_creation_input_tokens
					const cacheReadTokens =
						promptTokensDetails?.cached_tokens ??
						(typeof usageAny.prompt_cache_hit_tokens === "number"
							? usageAny.prompt_cache_hit_tokens
							: undefined) ??
						(typeof usageAny.cache_read_input_tokens === "number" ? usageAny.cache_read_input_tokens : undefined);
					const cacheWriteTokens =
						promptTokensDetails?.cache_write_tokens ??
						(typeof usageAny.cache_creation_input_tokens === "number"
							? usageAny.cache_creation_input_tokens
							: undefined);
					result.usage = {
						promptTokens: chunk.usage.prompt_tokens,
						completionTokens: chunk.usage.completion_tokens,
						// Recomputed rather than trusting the raw total_tokens field —
						// pi's own openai-completions.ts does the same (its `totalTokens:
						// input + outputTokens + cacheReadTokens + cacheWriteTokens`
						// simplifies to exactly promptTokens + completionTokens, since
						// `input` there is promptTokens minus both cache fields). Some
						// OpenAI-compatible gateways report a total_tokens that doesn't
						// actually match prompt+completion; recomputing avoids surfacing
						// a "Total" that visibly disagrees with the two numbers next to it.
						totalTokens: chunk.usage.prompt_tokens + chunk.usage.completion_tokens,
						cost: typeof usageAny.cost === "number" ? usageAny.cost : undefined,
						cacheReadTokens: cacheReadTokens ?? undefined,
						cacheWriteTokens: cacheWriteTokens ?? undefined,
						uncachedTokens: chunk.usage.prompt_tokens - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0),
					};
				}

				const delta = chunk.choices[0]?.delta;
				if (!delta) {
					if (result.usage) {
						yieldedAny = true;
						yield result;
					}
					continue;
				}

				// 1. Check for reasoning in delta fields (OpenRouter: delta.reasoning)
				const deltaAny = delta as Record<string, unknown>;
				if (typeof deltaAny.reasoning === "string" && deltaAny.reasoning) {
					result.thinking = deltaAny.reasoning;
				}

				// 2. Parse content for <think>...</think> blocks (Qwen/DeepSeek raw)
				if (delta.content) {
					const parsed = thinkParser.parseContent(delta.content);
					if (parsed.thinking) result.thinking = (result.thinking ?? "") + parsed.thinking;
					if (parsed.content) result.content = parsed.content;
				}

				// Tool calls
				if (delta.tool_calls) {
					for (const tc of delta.tool_calls) {
						const idx = tc.index;
						if (!toolCallAccumulator.has(idx)) {
							toolCallAccumulator.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: "" });
						}
						const acc = toolCallAccumulator.get(idx)!;
						if (tc.id) acc.id = tc.id;
						if (tc.function?.name) acc.name = tc.function.name;
						if (tc.function?.arguments) acc.arguments += tc.function.arguments;
					}
				}

				const finishReason = chunk.choices[0]?.finish_reason;
				if (finishReason) {
					result.finishReason = finishReason;
					if (toolCallAccumulator.size > 0) {
						result.toolCalls = [...toolCallAccumulator.values()];
					}
				}

				yieldedAny = true;
				yield result;
			}

			// Flush any remaining thinking buffer
			const remaining = thinkParser.flush();
			if (remaining) {
				yieldedAny = true;
				yield { thinking: remaining };
			}
			return;
		} catch (error) {
			if (yieldedAny || signal?.aborted || attempt >= MAX_STREAM_RETRIES || !isRetryableStreamError(error)) {
				throw error;
			}
			attempt++;
			const reason = error instanceof Error ? error.message : String(error);
			yield { retrying: { attempt, maxAttempts: MAX_STREAM_RETRIES, reason } };
			await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
		}
	}
}

export interface CompletionResult {
	content: string;
	thinking: string;
	toolCalls?: Array<{ id: string; name: string; arguments: string }>;
	finishReason: string;
	usage?: Usage;
	/**
	 * Wall-clock time from the first streamed chunk to the last, in ms —
	 * undefined if nothing ever streamed (e.g. the request failed before any
	 * chunk arrived). Deliberately excludes time-to-first-token/prefill
	 * latency, matching how opencode's own TPS tracking defines it
	 * (packages/console/.../modelTpsLimiter.ts: tokens / (tsLastByte -
	 * tsFirstByte)) — this measures decoding throughput, not request latency.
	 */
	generationMs?: number;
}

export async function streamAndCollect(
	client: OpenAI,
	model: string,
	messages: Message[],
	tools: Tool[],
	maxTokens: number,
	signal?: AbortSignal,
	onToken?: (token: string) => void,
	onThinking?: (token: string) => void,
	reasoningBody: Record<string, unknown> = {},
	onRetry?: (attempt: number, maxAttempts: number, reason: string) => void,
): Promise<CompletionResult> {
	let content = "";
	let thinking = "";
	let toolCalls: Array<{ id: string; name: string; arguments: string }> | undefined;
	let finishReason = "stop";
	let usage: Usage | undefined;
	let firstChunkAt: number | undefined;

	for await (const chunk of streamChat(client, model, messages, tools, maxTokens, signal, reasoningBody)) {
		if (chunk.retrying) {
			onRetry?.(chunk.retrying.attempt, chunk.retrying.maxAttempts, chunk.retrying.reason);
			continue;
		}
		firstChunkAt ??= Date.now();

		if (chunk.usage) usage = chunk.usage;
		if (chunk.content) {
			content += chunk.content;
			onToken?.(chunk.content);
		}
		if (chunk.thinking) {
			thinking += chunk.thinking;
			onThinking?.(chunk.thinking);
		}
		if (chunk.toolCalls) toolCalls = chunk.toolCalls;
		if (chunk.finishReason) finishReason = chunk.finishReason;
	}
	// Capture wall-clock end after the stream is fully consumed (matching
	// opencode's tsLastByte-on-done pattern) rather than on the last chunk.
	const lastChunkAt = firstChunkAt !== undefined ? Date.now() : undefined;

	const generationMs =
		firstChunkAt !== undefined && lastChunkAt !== undefined ? lastChunkAt - firstChunkAt : undefined;
	return { content, thinking, toolCalls, finishReason, usage, generationMs };
}

// ============================================================================
// Prompt caching — Anthropic-style cache_control markers on OpenAI-compatible
// API. Supported by OpenRouter (anthropic/*), native Anthropic via LiteLLM,
// and any provider that honors the cache_control extension field. Providers
// that don't understand it silently ignore the extra property.
//
// Three breakpoints, matching pi's openai-completions.ts strategy:
//   1. System prompt — caches persona + instructions + context files
//   2. Last tool definition — caches the full tool definitions array
//   3. Last user/assistant message — caches conversation prefix up to the
//      growing tail, so each new turn only pays for the delta
// ============================================================================

interface CacheControlEphemeral {
	type: "ephemeral";
}

type ContentPartWithCacheControl = {
	type: "text";
	text: string;
	cache_control?: CacheControlEphemeral;
};

type ToolWithCacheControl = ChatCompletionTool & {
	cache_control?: CacheControlEphemeral;
};

const CACHE_CONTROL: CacheControlEphemeral = { type: "ephemeral" };

function addCacheControlToTextContent(
	message: Extract<ChatCompletionMessageParam, { role: "system" | "user" | "assistant" | "developer" }>,
): boolean {
	const content = message.content;
	if (typeof content === "string") {
		if (content.length === 0) return false;
		message.content = [
			{ type: "text", text: content, cache_control: CACHE_CONTROL },
		] as ContentPartWithCacheControl[];
		return true;
	}
	if (Array.isArray(content)) {
		for (let i = content.length - 1; i >= 0; i--) {
			const part = content[i];
			if (
				part &&
				typeof part === "object" &&
				"type" in part &&
				(part as unknown as Record<string, unknown>).type === "text"
			) {
				(part as ContentPartWithCacheControl).cache_control = CACHE_CONTROL;
				return true;
			}
		}
	}
	return false;
}

/**
 * Apply Anthropic-style cache_control markers to messages and tools in-place.
 * Call right before sending each LLM request. The mutations are destructive
 * (messages are converted to structured content arrays), which is fine because
 * the messages array is rebuilt from session state each turn anyway.
 */
export function applyCacheControl(messages: Message[], tools: Tool[]): void {
	// 1. System prompt — first system/developer message
	for (const message of messages) {
		if (message.role === "system" || message.role === "developer") {
			addCacheControlToTextContent(message);
			break;
		}
	}

	// 2. Last tool definition
	if (tools.length > 0) {
		const lastTool = tools[tools.length - 1] as ToolWithCacheControl;
		lastTool.cache_control = CACHE_CONTROL;
	}

	// 3. Last user or assistant message (walking backward)
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" || message.role === "assistant") {
			if (addCacheControlToTextContent(message)) break;
		}
	}
}
