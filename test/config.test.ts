import { describe, expect, it } from "vitest";
import { classifyProviderError, loadConfig } from "../src/core/config.ts";

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
		expect(config.defaultBashTimeout).toBe(180);
	});

	it("uses an explicit connection over env vars", () => {
		process.env.PROVIDER_BASE_URL = "https://env-should-be-ignored.example";
		process.env.PROVIDER_API_KEY = "env-key-ignored";

		const config = loadConfig({ baseURL: "https://explicit.example/v1", apiKey: "explicit-key" });
		expect(config.baseURL).toBe("https://explicit.example/v1");
		expect(config.apiKey).toBe("explicit-key");
	});
});

describe("classifyProviderError", () => {
	it("classifies a revoked/invalid key (401 by status) as auth", () => {
		expect(classifyProviderError(Object.assign(new Error("401 status code (no body)"), { status: 401 }))).toBe(
			"auth",
		);
	});

	it("classifies a 401 by wording when no status is attached", () => {
		expect(classifyProviderError(new Error("Unauthorized: invalid api key"))).toBe("auth");
	});

	it("classifies a 403 as permission", () => {
		expect(classifyProviderError(Object.assign(new Error("403 Forbidden"), { status: 403 }))).toBe("permission");
	});

	it("classifies network failures as unreachable", () => {
		expect(classifyProviderError(new Error("fetch failed"))).toBe("unreachable");
		expect(classifyProviderError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBe(
			"unreachable",
		);
	});

	it("defaults to unknown for anything unrecognized (e.g. no /v1/models 404)", () => {
		// A provider that just doesn't implement /v1/models must NOT be treated as
		// a connection failure — otherwise startup would nag for credentials that
		// are actually fine.
		expect(classifyProviderError(Object.assign(new Error("404 Not Found"), { status: 404 }))).toBe("unknown");
	});
});
