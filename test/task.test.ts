import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { EMPTY_ASSISTANT_PLACEHOLDER, type Message } from "../src/core/llm.ts";
import { execTask, extractTaskResult } from "../src/core/tools/task.ts";

const testConfig = {
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
} as AppConfig;

describe("extractTaskResult", () => {
	it("skips the empty-assistant placeholder and picks the prior report", () => {
		const messages: Message[] = [
			{ role: "user", content: "do it" },
			{ role: "assistant", content: "Findings:\n- ok at src/a.ts:1" },
			{ role: "assistant", content: EMPTY_ASSISTANT_PLACEHOLDER },
		];
		expect(extractTaskResult(messages)).toBe("Findings:\n- ok at src/a.ts:1");
	});

	it("skips blank and non-string assistant content", () => {
		const messages: Message[] = [
			{ role: "assistant", content: "real report" },
			{ role: "assistant", content: "   " },
			{ role: "assistant", content: null },
		];
		expect(extractTaskResult(messages)).toBe("real report");
	});

	it("returns empty when only placeholders remain", () => {
		const messages: Message[] = [
			{ role: "user", content: "x" },
			{ role: "assistant", content: EMPTY_ASSISTANT_PLACEHOLDER },
			{ role: "assistant", content: "" },
		];
		expect(extractTaskResult(messages)).toBe("");
	});
});

describe("execTask — final extract", () => {
	it("returns the report when the last assistant turn is the placeholder", async () => {
		const result = await execTask({ assignment: "review mod-a" }, "/tmp", testConfig, {
			model: "test-model",
			subagentPrompts: [
				{ name: "worker", label: "Worker", description: "", systemPrompt: "worker", agentsMd: false },
			],
			runAgentLoop: async (messages, config) => {
				config.onEvent({ type: "end", reason: "stop" });
				return [
					...messages,
					{ role: "assistant", content: "Report: all clear in mod-a." },
					{ role: "assistant", content: EMPTY_ASSISTANT_PLACEHOLDER },
				];
			},
		});
		expect(result.isError).toBeFalsy();
		expect(result.content).toBe("Report: all clear in mod-a.");
	});

	it("errors when assistants are only placeholders", async () => {
		const result = await execTask({ assignment: "review mod-a" }, "/tmp", testConfig, {
			model: "test-model",
			subagentPrompts: [
				{ name: "worker", label: "Worker", description: "", systemPrompt: "worker", agentsMd: false },
			],
			runAgentLoop: async (messages, config) => {
				config.onEvent({ type: "end", reason: "stop" });
				return [...messages, { role: "assistant", content: EMPTY_ASSISTANT_PLACEHOLDER }];
			},
		});
		expect(result.isError).toBe(true);
		expect(result.content).toContain("no output");
	});

	it("lists available subagents for an unknown name", async () => {
		const result = await execTask({ assignment: "do it", subagent: "nope" }, "/tmp", testConfig, {
			model: "test-model",
			subagentPrompts: [
				{ name: "worker", label: "Worker", description: "", systemPrompt: "worker", agentsMd: false },
			],
			runAgentLoop: async () => {
				throw new Error("should not run");
			},
		});
		expect(result.isError).toBe(true);
		expect(result.content).toContain('Unknown subagent "nope"');
		expect(result.content).toContain("worker");
	});

	it("defaults to worker when present even if another name sorts earlier", async () => {
		let systemPrompt = "";
		await execTask({ assignment: "do it" }, "/tmp", testConfig, {
			model: "test-model",
			subagentPrompts: [
				{ name: "analyst", label: "Analyst", description: "", systemPrompt: "analyst prompt", agentsMd: false },
				{ name: "worker", label: "Worker", description: "", systemPrompt: "worker prompt", agentsMd: false },
			],
			runAgentLoop: async (messages, config) => {
				systemPrompt = config.systemPrompt;
				config.onEvent({ type: "end", reason: "stop" });
				return [...messages, { role: "assistant", content: "done" }];
			},
		});
		expect(systemPrompt).toContain("worker prompt");
		expect(systemPrompt).toContain("Current working directory:");
	});

	it("cancels while queued on the semaphore without starting the loop", async () => {
		const ac = new AbortController();
		let started = 0;
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const deps = {
			model: "test-model",
			subagentPrompts: [
				{ name: "worker", label: "Worker", description: "", systemPrompt: "worker", agentsMd: false },
			],
			runAgentLoop: async (messages: Message[]) => {
				started++;
				await gate;
				return [...messages, { role: "assistant", content: "done" }];
			},
		};
		const runs = Array.from({ length: 13 }, () =>
			execTask({ assignment: "work" }, "/tmp", testConfig, deps, ac.signal),
		);
		await new Promise((r) => setTimeout(r, 20));
		expect(started).toBe(10);

		ac.abort();
		const queued = await Promise.all(runs.slice(10));
		for (const r of queued) {
			expect(r.isError).toBe(true);
			expect(r.content).toContain("cancelled before start");
		}
		expect(started).toBe(10);

		release();
		await Promise.all(runs.slice(0, 10));
	});
});
