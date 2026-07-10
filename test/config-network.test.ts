import { beforeEach, describe, expect, it, vi } from "vitest";

// Replace only the default OpenAI client with a controllable stub; each test
// sets what chat.completions.create resolves/rejects with and what models.list
// yields or throws. Named exports (error classes) are preserved.
let chatCreate: () => Promise<unknown>;
let modelsList: () => unknown;

vi.mock("openai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("openai")>();
	class MockOpenAI {
		chat = { completions: { create: () => chatCreate() } };
		models = { list: () => modelsList() };
	}
	return { ...actual, default: MockOpenAI };
});

const { validateModel, runOnboardingCheck, probeProvider } = await import("../src/core/config.ts");

const cfg = { baseURL: "https://prov.test/v1", apiKey: "sk-x" } as Parameters<typeof validateModel>[0];

/** An async-iterable whose first `.next()` yields one item (a live models list). */
const listWithItem = () => ({
	[Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: { id: "m" } }) }),
});
const err = (message: string, status?: number) => Object.assign(new Error(message), status ? { status } : {});

beforeEach(() => {
	chatCreate = async () => ({ choices: [{ message: { content: "ok" } }] });
	modelsList = () => listWithItem();
});

describe("validateModel", () => {
	it("ok with a response snippet when the model replies", async () => {
		chatCreate = async () => ({ choices: [{ message: { content: "hello there" } }] });
		expect(await validateModel(cfg, "m")).toEqual({ ok: true, responseSnippet: "hello there" });
	});

	it("fails on an empty response (no content, no reasoning)", async () => {
		chatCreate = async () => ({ choices: [{ message: { content: "" } }] });
		const r = await validateModel(cfg, "m");
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/empty response/i);
	});

	it("maps a 401 to a key-rejected message", async () => {
		chatCreate = async () => {
			throw err("401 Unauthorized", 401);
		};
		expect(await validateModel(cfg, "m")).toEqual({
			ok: false,
			error: "API key rejected. Check your provider API key.",
		});
	});

	it("maps a 404 to a model-not-found message", async () => {
		chatCreate = async () => {
			throw err("404 not found");
		};
		const r = await validateModel(cfg, "gone");
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/Model "gone" not found/);
	});

	it("treats a 429 rate limit as a valid key", async () => {
		chatCreate = async () => {
			throw err("429 rate limit exceeded");
		};
		const r = await validateModel(cfg, "m");
		expect(r.ok).toBe(true);
		expect(r.responseSnippet).toMatch(/rate limited/i);
	});

	it("maps a connection refusal to a cannot-connect message", async () => {
		chatCreate = async () => {
			throw err("connect ECONNREFUSED 127.0.0.1:443");
		};
		const r = await validateModel(cfg, "m");
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/Cannot connect/);
	});
});

describe("runOnboardingCheck", () => {
	const silent = { log: () => {} };

	it("returns true when endpoint and model both pass", async () => {
		expect(await runOnboardingCheck(cfg, "m", silent)).toBe(true);
	});

	it("returns false when the endpoint rejects the key (401 on models.list)", async () => {
		modelsList = () => {
			throw err("401 Unauthorized", 401);
		};
		expect(await runOnboardingCheck(cfg, "m", silent)).toBe(false);
	});

	it("returns false when the endpoint is fine but the model fails", async () => {
		chatCreate = async () => {
			throw err("404 not found");
		};
		expect(await runOnboardingCheck(cfg, "m", silent)).toBe(false);
	});

	it("tolerates a provider without /v1/models and still validates the model", async () => {
		// models.list 404 is not fatal — the model check is the real test.
		modelsList = () => {
			throw err("404 no such route");
		};
		expect(await runOnboardingCheck(cfg, "m", silent)).toBe(true);
	});
});

describe("probeProvider", () => {
	it("returns 'ok' when the models list is reachable", async () => {
		expect(await probeProvider(cfg)).toBe("ok");
	});

	it("classifies a 401 as auth", async () => {
		modelsList = () => {
			throw err("401 Unauthorized", 401);
		};
		expect(await probeProvider(cfg)).toBe("auth");
	});

	it("classifies an unrecognized failure as unknown", async () => {
		modelsList = () => {
			throw err("404 Not Found", 404);
		};
		expect(await probeProvider(cfg)).toBe("unknown");
	});
});
