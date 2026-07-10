import OpenAI from "openai";
import type { ModelReasoningMeta, ReasoningParams } from "./vendors.ts";
import { extractReasoningMeta } from "./vendors.ts";

// ============================================================================
// Config
// ============================================================================

export interface AppConfig {
	baseURL: string;
	apiKey: string;
	contextWindow: number;
	maxResponseTokens: number;
	compactionThreshold: number;
	maxToolOutputLines: number;
	maxToolOutputBytes: number;
	defaultBashTimeout: number;
	reasoningLevel: string;
	reasoningParams: ReasoningParams;
}

/**
 * Build the app config. The interactive CLI resolves a connection via saved
 * settings or an interactive prompt and always passes it explicitly; see
 * `resolveConnection` in select.ts.
 */
export function loadConfig(connection: { baseURL: string; apiKey: string }): AppConfig {
	const { baseURL, apiKey } = connection;

	return {
		baseURL,
		apiKey,
		contextWindow: 128_000,
		maxResponseTokens: 8192,
		compactionThreshold: 0.75,
		maxToolOutputLines: 2000,
		maxToolOutputBytes: 64 * 1024,
		defaultBashTimeout: 180,
		reasoningLevel: "off",
		reasoningParams: { body: {}, enabled: false },
	};
}

// ============================================================================
// Model info (from OpenRouter /v1/models)
// ============================================================================

/**
 * Fallback context window sizes for known models when the provider's
 * /v1/models doesn't expose `context_length`. Matched by substring
 * (case-insensitive) against the model id — first match wins.
 * Add new models here as { "model-substring": contextTokens }.
 */
const KNOWN_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	"mimo-v2.5": 1_000_000,
	"mimo-v2.5-pro": 1_000_000,
};

export function lookupContextWindow(modelId: string): number | undefined {
	const lower = modelId.toLowerCase();
	for (const [pattern, ctx] of Object.entries(KNOWN_MODEL_CONTEXT_WINDOWS)) {
		if (lower.includes(pattern.toLowerCase())) return ctx;
	}
	return undefined;
}

export interface ModelInfo {
	id: string;
	ownedBy?: string;
	reasoning?: ModelReasoningMeta;
	/** Context window size in tokens (from /v1/models) */
	contextWindow?: number;
}

export interface FetchModelsResult {
	ok: boolean;
	models?: ModelInfo[];
	error?: string;
}

/**
 * Fetch model list from /v1/models.
 * Extracts reasoning metadata directly from the response.
 */
export async function fetchModels(config: AppConfig): Promise<FetchModelsResult> {
	// See llm.ts createClient: the SDK's bundled node-fetch shim mishandles a
	// connection dying mid-response; native fetch doesn't have that failure mode.
	const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey, fetch: globalThis.fetch });

	try {
		const list = await client.models.list();
		const models: ModelInfo[] = [];

		for await (const model of list) {
			const raw = model as unknown as Record<string, unknown>;
			models.push({
				id: model.id,
				ownedBy: model.owned_by,
				reasoning: extractReasoningMeta(raw) ?? undefined,
				contextWindow:
					(typeof raw.context_length === "number" ? raw.context_length : undefined) ??
					lookupContextWindow(model.id),
			});
		}

		models.sort((a, b) => a.id.localeCompare(b.id));
		return { ok: true, models };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		if (message.includes("ECONNREFUSED") || message.includes("fetch failed") || message.includes("ENOTFOUND")) {
			return { ok: false, error: `Cannot connect to ${config.baseURL}` };
		}

		if (message.includes("ETIMEDOUT")) {
			return { ok: false, error: `Connection to ${config.baseURL} timed out` };
		}

		if (message.includes("401") || message.includes("Unauthorized") || message.includes("Invalid API key")) {
			return { ok: false, error: "API key rejected" };
		}

		if (message.includes("403") || message.includes("Forbidden")) {
			return { ok: false, error: "Access denied" };
		}

		return { ok: false, error: `Endpoint does not support /v1/models (${message.slice(0, 100)})` };
	}
}

// ============================================================================
// Validation
// ============================================================================

export interface ValidationResult {
	ok: boolean;
	error?: string;
	responseSnippet?: string;
}

export async function validateModel(config: AppConfig, model: string): Promise<ValidationResult> {
	// See llm.ts createClient: the SDK's bundled node-fetch shim mishandles a
	// connection dying mid-response; native fetch doesn't have that failure mode.
	const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey, fetch: globalThis.fetch });

	try {
		const response = await client.chat.completions.create({
			model,
			messages: [{ role: "user", content: "Say exactly: ok" }],
			max_tokens: 50,
		});

		const msg = response.choices[0]?.message;
		const content = msg?.content ?? "";

		// Check for reasoning in response
		const msgAny = msg as unknown as Record<string, unknown> | undefined;
		const reasoning = typeof msgAny?.reasoning === "string" ? msgAny.reasoning : undefined;

		if (!content && !reasoning) {
			return { ok: false, error: `Model "${model}" returned empty response.` };
		}

		return { ok: true, responseSnippet: (content || reasoning || "").slice(0, 100) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		if (message.includes("ECONNREFUSED") || message.includes("fetch failed") || message.includes("ENOTFOUND")) {
			return { ok: false, error: `Cannot connect to ${config.baseURL}` };
		}

		if (message.includes("ETIMEDOUT")) {
			return { ok: false, error: `Connection to ${config.baseURL} timed out` };
		}

		if (message.includes("401") || message.includes("Unauthorized") || message.includes("Invalid API key")) {
			return { ok: false, error: "API key rejected. Check your provider API key." };
		}

		if (message.includes("403") || message.includes("Forbidden")) {
			return { ok: false, error: "Access denied. Key may lack permissions for this model." };
		}

		if (message.includes("404") || message.includes("not found") || message.includes("does not exist")) {
			return { ok: false, error: `Model "${model}" not found. Check the model name.` };
		}

		if (message.includes("429") || message.includes("rate limit")) {
			return { ok: true, responseSnippet: "(rate limited, but key is valid)" };
		}

		return { ok: false, error: message.slice(0, 300) };
	}
}

// ============================================================================
// Onboarding
// ============================================================================

/**
 * @param silent Suppress the per-step "endpoint: ok" / "model: ok" progress
 * output on success — used for the "reuse saved model" fast path, where a
 * clean banner follows right after and repeating "ok" a few times is just
 * noise. Failure diagnostics still print either way, since those are the
 * only useful thing to say when this path doesn't just fall through to the
 * banner.
 * @param log Where progress lines go — defaults to `console.log` (fine for
 * pre-mount onboarding). Callers running inside the live TUI
 * pass `pickers.log` instead, since a raw stdout write here would corrupt
 * Ink's managed frame.
 */
export async function runOnboardingCheck(
	config: AppConfig,
	model: string,
	{ silent = false, log = console.log }: { silent?: boolean; log?: (text: string) => void } = {},
): Promise<boolean> {
	// See llm.ts createClient: the SDK's bundled node-fetch shim mishandles a
	// connection dying mid-response; native fetch doesn't have that failure mode.
	const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey, fetch: globalThis.fetch });

	// Step 1: Check endpoint + key
	try {
		const list = await client.models.list();
		// Consume first item to verify it works
		const first = await list[Symbol.asyncIterator]().next();
		if (!silent) log(`Endpoint + API key: ok${first.done ? " (empty model list)" : ""}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		if (message.includes("ECONNREFUSED") || message.includes("fetch failed") || message.includes("ENOTFOUND")) {
			log(`Endpoint + API key: failed — cannot reach ${config.baseURL}`);
			return false;
		}

		if (message.includes("401") || message.includes("Unauthorized") || message.includes("Invalid API key")) {
			log("Endpoint + API key: rejected — check your provider API key.");
			return false;
		}

		if (message.includes("403")) {
			log("Endpoint + API key: no permissions.");
			return false;
		}

		// Some providers just don't implement /v1/models — not fatal, the model
		// check below is the real test.
		log("Endpoint + API key: ok");
	}

	// Step 2: Validate model
	const result = await validateModel(config, model);

	if (result.ok) {
		if (!silent) {
			log(`Model "${model}": ok${result.responseSnippet ? ` — response: "${result.responseSnippet}"` : ""}`);
		}
		return true;
	}

	log(`Model "${model}": failed — ${result.error}`);
	return false;
}

/** Outcome of a provider liveness probe — see probeProvider. */
export type ProviderProbe = "ok" | "auth" | "permission" | "unreachable" | "unknown";

/**
 * Classify why a provider request failed, from status/wording. Pure so it can
 * be unit-tested without a live endpoint. "unknown" is the safe default (e.g. a
 * provider that just doesn't implement /v1/models) — callers treat it as "not
 * clearly a connection failure" and don't force a credential re-prompt on it.
 */
export function classifyProviderError(error: unknown): Exclude<ProviderProbe, "ok"> {
	const status = (error as { status?: number } | undefined)?.status;
	const message = error instanceof Error ? error.message : String(error);
	if (status === 401 || /\b401\b|unauthorized|invalid api key/i.test(message)) return "auth";
	if (status === 403 || /\b403\b|forbidden/i.test(message)) return "permission";
	if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed/i.test(message)) return "unreachable";
	return "unknown";
}

/**
 * Lightweight endpoint + key liveness check, classified. Used on the startup
 * failure path to tell "the saved model is gone" (→ pick another) apart from
 * "the key/endpoint is dead" (→ re-enter provider credentials). Routing a
 * revoked-key user to a model picker is a dead end: no model id can validate
 * against a rejected key.
 */
export async function probeProvider(config: AppConfig): Promise<ProviderProbe> {
	// See llm.ts createClient: native fetch avoids the SDK shim's mid-response bug.
	const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey, fetch: globalThis.fetch });
	try {
		const list = await client.models.list();
		await list[Symbol.asyncIterator]().next();
		return "ok";
	} catch (error) {
		return classifyProviderError(error);
	}
}
