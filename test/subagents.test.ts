import { describe, expect, it } from "vitest";
import { findSubagentPrompt, loadSubagentPrompts } from "../src/core/subagents.ts";

describe("loadSubagentPrompts", () => {
	it("loads the built-in worker subagent", () => {
		const prompts = loadSubagentPrompts();
		expect(prompts.length).toBeGreaterThanOrEqual(1);
		const worker = prompts.find((p) => p.name === "worker");
		expect(worker).toBeDefined();
		expect(worker!.label).toBe("Worker");
		expect(worker!.systemPrompt.length).toBeGreaterThan(0);
	});

	it("each prompt has name, label, description, systemPrompt", () => {
		for (const p of loadSubagentPrompts()) {
			expect(p.name).toBeTruthy();
			expect(p.label).toBeTruthy();
			expect(typeof p.description).toBe("string");
			expect(p.systemPrompt.length).toBeGreaterThan(0);
		}
	});

	it("strips frontmatter from systemPrompt", () => {
		for (const p of loadSubagentPrompts()) {
			expect(p.systemPrompt).not.toContain("---");
		}
	});
});

describe("findSubagentPrompt", () => {
	it("finds worker by name", () => {
		const all = loadSubagentPrompts();
		const worker = findSubagentPrompt("worker", all);
		expect(worker).toBeDefined();
		expect(worker!.name).toBe("worker");
	});

	it("returns undefined for unknown name", () => {
		const all = loadSubagentPrompts();
		expect(findSubagentPrompt("nonexistent", all)).toBeUndefined();
	});
});
