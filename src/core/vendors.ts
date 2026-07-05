/**
 * Reasoning configuration — derived directly from OpenRouter /v1/models metadata.
 *
 * Each model from OpenRouter includes a `reasoning` field:
 * {
 *   "mandatory": false,
 *   "default_enabled": true,
 *   "supported_efforts": ["high", "medium", "low"],
 *   "default_effort": "medium"
 * }
 *
 * No vendor detection, no overrides, no cache — the API tells us everything.
 */

// ============================================================================
// Model reasoning metadata (from OpenRouter /v1/models)
// ============================================================================

export interface ModelReasoningMeta {
	mandatory: boolean;
	defaultEnabled: boolean;
	supportedEfforts: string[];
	defaultEffort: string;
}

/**
 * Extract reasoning metadata from OpenRouter model object.
 * Returns null if model doesn't support reasoning.
 */
export function extractReasoningMeta(model: Record<string, unknown>): ModelReasoningMeta | null {
	const r = model.reasoning as Record<string, unknown> | undefined;
	if (!r) return null;

	return {
		mandatory: r.mandatory === true,
		defaultEnabled: r.default_enabled === true,
		supportedEfforts: Array.isArray(r.supported_efforts) ? (r.supported_efforts as string[]) : [],
		defaultEffort: typeof r.default_effort === "string" ? r.default_effort : "medium",
	};
}

// ============================================================================
// Build request parameters
// ============================================================================

export interface ReasoningParams {
	body: Record<string, unknown>;
	enabled: boolean;
}

export function buildReasoningParams(effort: string): ReasoningParams {
	if (effort === "unknown") {
		// Provider didn't report reasoning capabilities — don't send any
		// reasoning params so the provider uses its own default.
		return { body: {}, enabled: false };
	}
	if (effort === "off") {
		// Must be explicit. Some models (e.g. OpenRouter's `default_enabled:
		// true` ones) reason by default when the `reasoning` key is omitted
		// entirely — an empty body doesn't turn reasoning off, it just leaves
		// the provider's own default in place. Confirmed live: omitting the
		// key returns a populated `reasoning` field even though we asked for
		// "off". Sending `enabled: false` on a model with no reasoning support
		// at all is a harmless no-op (verified against gpt-4o-mini).
		return { body: { reasoning: { enabled: false } }, enabled: false };
	}
	if (effort === "on") {
		// Binary-toggle models (see getReasoningOptions) don't take an effort
		// level — just turn reasoning on.
		return { body: { reasoning: { enabled: true } }, enabled: true };
	}
	return {
		body: { reasoning: { effort } },
		enabled: true,
	};
}

// ============================================================================
// UI helpers
// ============================================================================

export function getReasoningOptions(meta: ModelReasoningMeta | null): Array<{ value: string; label: string }> {
	if (!meta) return [];

	if (meta.supportedEfforts.length === 0) {
		// Model reports reasoning support but as a binary toggle only (e.g.
		// OpenRouter's `{ mandatory, default_enabled }` shape with no
		// `supported_efforts` list) — offer on/off instead of an effort menu.
		return [
			{ value: "off", label: "Off (no reasoning)" },
			{ value: "on", label: `On${meta.defaultEnabled ? " (default)" : ""}` },
		];
	}

	const options: Array<{ value: string; label: string }> = [{ value: "off", label: "Off (no reasoning)" }];

	for (const effort of meta.supportedEfforts) {
		const label = effort.charAt(0).toUpperCase() + effort.slice(1);
		options.push({
			value: effort,
			label: `${label}${effort === meta.defaultEffort ? " (default)" : ""}`,
		});
	}

	return options;
}

// ============================================================================
// Parse <think> blocks from content (for raw Qwen/DeepSeek without OpenRouter)
// ============================================================================

export class ThinkBlockParser {
	private inThinkBlock = false;
	private thinkBuffer = "";

	parseContent(text: string): { thinking?: string; content?: string } {
		const result: { thinking?: string; content?: string } = {};

		if (this.inThinkBlock) {
			const endIdx = text.indexOf("</think>");
			if (endIdx !== -1) {
				this.thinkBuffer += text.slice(0, endIdx);
				result.thinking = this.thinkBuffer;
				this.thinkBuffer = "";
				this.inThinkBlock = false;
				const remaining = text.slice(endIdx + 8);
				if (remaining) result.content = remaining;
			} else {
				this.thinkBuffer += text;
				result.thinking = text;
			}
		} else {
			const startIdx = text.indexOf("<think>");
			if (startIdx !== -1) {
				const before = text.slice(0, startIdx);
				if (before) result.content = before;
				const afterStart = text.slice(startIdx + 7);
				const endIdx = afterStart.indexOf("</think>");
				if (endIdx !== -1) {
					result.thinking = afterStart.slice(0, endIdx);
					const remaining = afterStart.slice(endIdx + 8);
					if (remaining) result.content = (result.content ?? "") + remaining;
				} else {
					this.thinkBuffer = afterStart;
					this.inThinkBlock = true;
					result.thinking = afterStart;
				}
			} else {
				result.content = text;
			}
		}

		return result;
	}

	flush(): string | undefined {
		if (this.inThinkBlock && this.thinkBuffer) {
			const r = this.thinkBuffer;
			this.thinkBuffer = "";
			this.inThinkBlock = false;
			return r;
		}
		return undefined;
	}
}
