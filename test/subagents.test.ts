import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import type { Message } from "../src/core/llm.ts";
import type { LoopConfig } from "../src/core/loop.ts";
import { findSubagentPrompt, loadSubagentPrompts, type SubagentPrompt } from "../src/core/subagents.ts";
import { execTask } from "../src/core/tools/task.ts";

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

/** Run execTask with a fake loop that just records the child's LoopConfig. */
async function captureChildConfig(deps: Partial<Parameters<typeof execTask>[3]>): Promise<LoopConfig> {
	let captured: LoopConfig | undefined;
	const runAgentLoop = async (messages: Message[], config: LoopConfig): Promise<Message[]> => {
		captured = config;
		config.onEvent({ type: "end", reason: "stop" });
		return [...messages, { role: "assistant", content: "child done" }];
	};
	const result = await execTask({ assignment: "explore something" }, "/tmp", testConfig, {
		model: "test-model",
		runAgentLoop,
		...deps,
	});
	expect(result.isError).toBeFalsy();
	expect(captured).toBeDefined();
	return captured!;
}

describe("execTask — plan state handoff", () => {
	it("build mode: child inherits the plan (mirror) but never the plan tools", async () => {
		const child = await captureChildConfig({
			planState: { enabled: false, plansDir: "/tmp/plans-x" },
			disabledTools: new Set(["web_search"]),
		});
		expect(child.planState).toEqual({ enabled: false, plansDir: "/tmp/plans-x" });
		expect(child.disabledTools!.has("plan_write")).toBe(true);
		expect(child.disabledTools!.has("plan_check")).toBe(true);
		expect(child.disabledTools!.has("web_search")).toBe(true);
		expect(child.disabledTools!.has("bash")).toBe(false);
		expect(child.readOnlyBash).toBe(false);
	});

	it("plan mode: child runs with enabled=false (no authoring block) and inherits read-only bash", async () => {
		const child = await captureChildConfig({
			planState: { enabled: true, plansDir: "/tmp/plans-y" },
			disabledTools: new Set(["write", "edit"]),
		});
		expect(child.planState!.enabled).toBe(false);
		expect(child.planState!.plansDir).toBe("/tmp/plans-y");
		// bash stays advertised — the executor's read-only gate applies instead
		expect(child.disabledTools!.has("bash")).toBe(false);
		expect(child.readOnlyBash).toBe(true);
		expect(child.disabledTools!.has("write")).toBe(true);
	});

	it("no plan state: child gets none", async () => {
		const child = await captureChildConfig({});
		expect(child.planState).toBeUndefined();
		expect(child.disabledTools!.has("bash")).toBe(false);
		expect(child.readOnlyBash).toBe(false);
	});
});

describe("loadSubagentPrompts", () => {
	it("loads the built-in worker subagent", () => {
		const prompts = loadSubagentPrompts();
		expect(prompts.length).toBeGreaterThanOrEqual(1);
		const worker = prompts.find((p) => p.name === "worker");
		expect(worker).toBeDefined();
		expect(worker!.label).toBe("Worker");
		expect(worker!.systemPrompt.length).toBeGreaterThan(0);
		// Same shared file-tool contract as personas — not role-specific.
		expect(worker!.systemPrompt).toContain("## File tools / hashline anchors");
		expect(worker!.systemPrompt).toContain("## Error Handling");
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

	it("builtins default to all tools and agentsMd true", () => {
		for (const p of loadSubagentPrompts()) {
			expect(p.tools).toBeUndefined();
			expect(p.agentsMd).toBe(true);
		}
	});
});

describe("execTask — tools allowlist and agentsMd", () => {
	const tmpDir = join(import.meta.dirname, "__test_tmp_subagent_agents__");

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("passes subagent.tools as child allowedTools", async () => {
		const explorer: SubagentPrompt = {
			name: "explorer",
			label: "Explorer",
			description: "read-only",
			systemPrompt: "Explore only.",
			tools: ["read", "grep", "ls"],
			agentsMd: true,
		};
		let captured: LoopConfig | undefined;
		await execTask({ assignment: "map the tree", subagent: "explorer" }, "/tmp", testConfig, {
			model: "test-model",
			subagentPrompts: [explorer],
			runAgentLoop: async (messages, config) => {
				captured = config;
				config.onEvent({ type: "end", reason: "stop" });
				return [...messages, { role: "assistant", content: "done" }];
			},
		});
		expect(captured!.allowedTools).toEqual(["read", "grep", "ls"]);
	});

	it("leaves allowedTools undefined when subagent omits tools", async () => {
		const child = await captureChildConfig({
			subagentPrompts: [
				{
					name: "worker",
					label: "Worker",
					description: "",
					systemPrompt: "work",
					agentsMd: true,
				},
			],
		});
		expect(child.allowedTools).toBeUndefined();
	});

	it("injects AGENTS.md into the child system prompt when agentsMd is true", async () => {
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(join(tmpDir, "AGENTS.md"), "TRUSTED PROJECT RULES\n", "utf-8");
		const worker: SubagentPrompt = {
			name: "worker",
			label: "Worker",
			description: "",
			systemPrompt: "ROLE_PROMPT",
			agentsMd: true,
		};
		let childPrompt = "";
		await execTask({ assignment: "do work" }, tmpDir, testConfig, {
			model: "test-model",
			subagentPrompts: [worker],
			projectTrusted: true,
			runAgentLoop: async (messages, config) => {
				childPrompt = config.systemPrompt;
				config.onEvent({ type: "end", reason: "stop" });
				return [...messages, { role: "assistant", content: "done" }];
			},
		});
		expect(childPrompt).toContain("ROLE_PROMPT");
		expect(childPrompt).toContain("TRUSTED PROJECT RULES");
		expect(childPrompt).toContain("<project_context>");
	});

	it("skips AGENTS.md when agentsMd is false", async () => {
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(join(tmpDir, "AGENTS.md"), "SHOULD NOT APPEAR\n", "utf-8");
		const worker: SubagentPrompt = {
			name: "worker",
			label: "Worker",
			description: "",
			systemPrompt: "ROLE_ONLY",
			agentsMd: false,
		};
		let childPrompt = "";
		await execTask({ assignment: "do work" }, tmpDir, testConfig, {
			model: "test-model",
			subagentPrompts: [worker],
			projectTrusted: true,
			runAgentLoop: async (messages, config) => {
				childPrompt = config.systemPrompt;
				config.onEvent({ type: "end", reason: "stop" });
				return [...messages, { role: "assistant", content: "done" }];
			},
		});
		expect(childPrompt).toContain("ROLE_ONLY");
		expect(childPrompt).not.toContain("SHOULD NOT APPEAR");
		expect(childPrompt).toContain("Current working directory:");
	});

	it("injects cwd/system state, rules, skills, and mcp catalog into the child prompt", async () => {
		mkdirSync(join(tmpDir, ".cast", "rules"), { recursive: true });
		writeFileSync(join(tmpDir, "AGENTS.md"), "AGENTS BODY\n", "utf-8");
		writeFileSync(
			join(tmpDir, ".cast", "rules", "always.md"),
			"---\nalwaysApply: true\n---\nALWAYS RULE BODY\n",
			"utf-8",
		);
		const worker: SubagentPrompt = {
			name: "worker",
			label: "Worker",
			description: "",
			systemPrompt: "ROLE_PROMPT",
			agentsMd: true,
		};
		let childPrompt = "";
		let childSsh: unknown;
		await execTask({ assignment: "do work" }, tmpDir, testConfig, {
			model: "test-model",
			subagentPrompts: [worker],
			projectTrusted: true,
			mcpPromptSuffix: '\n<available_mcp>\n  <server name="demo" tools="1">\n  </server>\n</available_mcp>',
			sshHosts: [{ name: "box", host: "example.com", username: "u" }],
			runAgentLoop: async (messages, config) => {
				childPrompt = config.systemPrompt;
				childSsh = config.sshHosts;
				config.onEvent({ type: "end", reason: "stop" });
				return [...messages, { role: "assistant", content: "done" }];
			},
		});
		expect(childPrompt).toContain("ROLE_PROMPT");
		expect(childPrompt).toContain("AGENTS BODY");
		expect(childPrompt).toContain("ALWAYS RULE BODY");
		expect(childPrompt).toContain(`Current working directory: ${tmpDir}`);
		expect(childPrompt).toContain("Subagent: worker (Worker)");
		expect(childPrompt).toContain("Tool paths are relative to the current working directory above.");
		expect(childPrompt).toContain("<available_mcp>");
		expect(childPrompt).toContain('name="demo"');
		expect(childSsh).toEqual([{ name: "box", host: "example.com", username: "u" }]);
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
