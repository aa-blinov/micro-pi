import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.ts";

// ============================================================================
// loadConfig
// ============================================================================

describe("loadConfig", () => {
	it("loads config from an explicit connection", () => {
		process.env.PROVIDER_BASE_URL = "https://api.openai.com/v1";
		process.env.PROVIDER_API_KEY = "sk-test";

		const config = loadConfig({ baseURL: "https://api.openai.com/v1", apiKey: "sk-test" });
		expect(config.baseURL).toBe("https://api.openai.com/v1");
		expect(config.apiKey).toBe("sk-test");
		expect(config.contextWindow).toBe(128_000);
		expect(config.maxResponseTokens).toBe(8192);
		expect(config.defaultBashTimeout).toBe(120);
	});

	it("uses an explicit connection over env vars", () => {
		process.env.PROVIDER_BASE_URL = "https://env-should-be-ignored.example";
		process.env.PROVIDER_API_KEY = "env-key-ignored";

		const config = loadConfig({ baseURL: "https://explicit.example/v1", apiKey: "explicit-key" });
		expect(config.baseURL).toBe("https://explicit.example/v1");
		expect(config.apiKey).toBe("explicit-key");
	});
});
