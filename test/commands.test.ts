import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import type { McpSetupResult } from "../src/core/mcp.ts";
import type { Persona } from "../src/core/personas.ts";
import type { SessionState } from "../src/core/session.ts";
import type { PermissionMode } from "../src/core/settings.ts";
import type { Pickers } from "../src/pickers/types.ts";
import type { CommandDeps } from "../src/ui/commands.ts";
import type { UseAgentSession } from "../src/ui/useAgentSession.ts";

const { handleInput } = await import("../src/ui/commands.ts");

interface Calls {
	[key: string]: unknown[][];
}

function createFakeDeps(overrides?: Partial<CommandDeps> & { running?: boolean }): {
	deps: CommandDeps;
	calls: Calls;
} {
	const calls: Calls = {};
	const track =
		(name: string) =>
		(...args: unknown[]) => {
			if (!calls[name]) calls[name] = [];
			calls[name].push(args);
		};

	const agent = {
		submit: track("agent.submit"),
		steer: track("agent.steer"),
		followUp: track("agent.followUp"),
		abort: track("agent.abort"),
		clearContext: track("agent.clearContext"),
		refresh: track("agent.refresh"),
		messages: [],
		streaming: null,
		status: "idle" as const,
		error: null,
		retry: null,
		usage: null,
	} as unknown as UseAgentSession;

	const session = {
		id: "test-session",
		messages: [],
		model: "test-model",
		createdAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:00:00.000Z",
		usage: {
			promptTokens: 100,
			completionTokens: 50,
			totalTokens: 150,
			cost: 0.001,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		},
		cwd: "/tmp",
	} as unknown as SessionState;

	const fakePickers: Pickers = {
		pickOption: async () => null,
		promptText: async () => null,
		log: () => {},
	};

	const deps: CommandDeps = {
		agent,
		session,
		config: {
			baseURL: "https://test.example/v1",
			apiKey: "sk-test",
			contextWindow: 128_000,
			maxResponseTokens: 8192,
			defaultBashTimeout: 120,
			compactionThreshold: 0.8,
			reasoningLevel: "off",
			reasoningParams: { body: {}, enabled: false },
		} as AppConfig,
		running: overrides?.running ?? false,
		onQuit: track("onQuit"),
		showNotice: track("showNotice"),
		cwd: "/tmp",
		setCwd: track("setCwd"),
		currentPersona: {
			name: "default",
			label: "Default",
			description: "test persona",
			systemPrompt: "you are a test",
		} as Persona,
		setCurrentPersona: track("setCurrentPersona"),
		skills: [],
		setSkills: track("setSkills"),
		skillsPromptSuffix: "",
		setSkillsPromptSuffix: track("setSkillsPromptSuffix"),
		contextFilesSuffix: "",
		setContextFilesSuffix: track("setContextFilesSuffix"),
		rulesSuffix: "",
		setRulesSuffix: track("setRulesSuffix"),
		systemPrompt: "",
		setSystemPrompt: track("setSystemPrompt"),
		mcpResult: {
			connections: [],
			toolDefinitions: [],
			toolIndex: new Map(),
			diagnostics: [],
		} as unknown as McpSetupResult,
		setMcpResult: track("setMcpResult"),
		permissionMode: "default" as PermissionMode,
		setPermissionMode: track("setPermissionMode"),
		projectTrusted: true,
		setProjectTrusted: track("setProjectTrusted"),
		projectDeps: {
			noSkills: false,
			noMcp: false,
			cliSkillPaths: [],
			cliMcpPaths: [],
			settings: {},
			pickers: fakePickers,
		},
		pickers: fakePickers,
		reasoningMeta: undefined,
		setReasoningMeta: track("setReasoningMeta"),
		...overrides,
	};

	return { deps, calls };
}

function noticeText(calls: Calls): string {
	return String(calls.showNotice?.[0]?.[0] ?? "");
}

describe("handleInput", () => {
	it("routes non-slash input to agent.submit", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("hello world", undefined, deps);
		expect(calls["agent.submit"]).toEqual([["hello world", undefined]]);
	});

	it("/quit calls onQuit", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/quit", undefined, deps);
		expect(calls.onQuit).toHaveLength(1);
	});

	it("/exit calls onQuit", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/exit", undefined, deps);
		expect(calls.onQuit).toHaveLength(1);
	});

	it("/abort calls agent.abort", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/abort", undefined, deps);
		expect(calls["agent.abort"]).toHaveLength(1);
	});

	it("/steer <msg> enqueues steering message", async () => {
		const { deps, calls } = createFakeDeps({ running: true });
		await handleInput("/steer fix the bug", undefined, deps);
		expect(calls["agent.steer"]).toEqual([["fix the bug"]]);
	});

	it("/queue <msg> enqueues follow-up", async () => {
		const { deps, calls } = createFakeDeps({ running: true });
		await handleInput("/queue next step", undefined, deps);
		expect(calls["agent.followUp"]).toEqual([["next step"]]);
	});

	it("blocks most commands while running", async () => {
		const { deps, calls } = createFakeDeps({ running: true });
		await handleInput("/clear", undefined, deps);
		expect(calls["agent.clearContext"]).toBeUndefined();
		expect(noticeText(calls)).toContain("running");
	});

	it("/clear calls agent.clearContext when idle", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/clear", undefined, deps);
		expect(calls["agent.clearContext"]).toHaveLength(1);
		expect(noticeText(calls)).toContain("cleared");
	});

	it("/usage shows token usage", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/usage", undefined, deps);
		expect(noticeText(calls)).toContain("100");
		expect(noticeText(calls)).toContain("150");
	});

	it("/context shows token estimate vs budget", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/context", undefined, deps);
		expect(noticeText(calls)).toContain("tokens");
		expect(noticeText(calls)).toContain("compacts");
	});

	it("/help lists command names", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/help", undefined, deps);
		expect(noticeText(calls)).toContain("/clear");
		expect(noticeText(calls)).toContain("/model");
		expect(noticeText(calls)).toContain("/quit");
	});

	it("/personas lists personas and marks current", async () => {
		const { deps, calls } = createFakeDeps({
			currentPersona: { name: "coding", label: "Coding", description: "Coding agent", systemPrompt: "" } as any,
		});
		await handleInput("/personas", undefined, deps);
		expect(noticeText(calls)).toContain("Personas:");
		expect(noticeText(calls)).toContain("(current)");
	});

	it("/persona cancelled (Escape) leaves the persona unchanged and doesn't exit the process", async () => {
		// Regression test: selectPersona used to call process.exit(0) when the
		// picker was cancelled — fine during onboarding (nothing to preserve
		// yet), but this same function is reused for the mid-session /persona
		// command, where that would silently kill the whole running app instead
		// of just leaving the current persona in place. fakePickers.pickOption
		// always resolves null, simulating Escape.
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit should not be called on a cancelled /persona");
		});
		try {
			const { deps, calls } = createFakeDeps();
			await handleInput("/persona", undefined, deps);
			const lastNotice = String(calls.showNotice?.at(-1)?.[0] ?? "");
			expect(lastNotice).toContain("Cancelled");
			expect(calls.setCurrentPersona).toBeUndefined();
		} finally {
			exitSpy.mockRestore();
		}
	});

	it("/model cancelled (Escape) leaves the model unchanged and doesn't exit the process", async () => {
		// Same underlying bug as /persona above, but for selectModel — reached
		// via /model, and also (unfixed until now) via /provider after a
		// successful credential change.
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit should not be called on a cancelled /model");
		});
		try {
			const { deps, calls } = createFakeDeps();
			await handleInput("/model", undefined, deps);
			const lastNotice = String(calls.showNotice?.at(-1)?.[0] ?? "");
			expect(lastNotice).toContain("Cancelled");
			expect(deps.session.model).toBe("test-model");
		} finally {
			exitSpy.mockRestore();
		}
	});

	it("/skills reports none loaded when empty", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/skills", undefined, deps);
		expect(noticeText(calls)).toContain("No skills");
	});

	it("/mcp reports none connected when empty", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/mcp", undefined, deps);
		expect(noticeText(calls)).toContain("No MCP");
	});

	it("/rules add without text shows usage", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/rules add", undefined, deps);
		expect(noticeText(calls)).toContain("Usage");
	});

	it("/rules add <text> writes to .cast/rules.md", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "cast-cmd-rules-"));
		const cwd = join(fakeHome, "project");
		mkdirSync(join(cwd, ".cast"), { recursive: true });
		let callCount = 0;
		const pickers: Pickers = {
			pickOption: async () => (callCount++ === 0 ? "local" : null),
			promptText: async () => null,
			log: () => {},
		};
		const { deps, calls } = createFakeDeps({ cwd, pickers });
		await handleInput("/rules add be excellent to each other", undefined, deps);
		const content = readFileSync(join(cwd, ".cast", "rules.md"), "utf-8");
		expect(content).toContain("be excellent to each other");
		expect(noticeText(calls)).not.toContain("not active");
		rmSync(fakeHome, { recursive: true, force: true });
	});

	it("/rules add <text> warns the rule isn't active when the project isn't trusted", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "cast-cmd-rules-untrusted-add-"));
		const cwd = join(fakeHome, "project");
		mkdirSync(join(cwd, ".cast"), { recursive: true });
		let callCount = 0;
		const pickers: Pickers = {
			pickOption: async () => (callCount++ === 0 ? "local" : null),
			promptText: async () => null,
			log: () => {},
		};
		const { deps, calls } = createFakeDeps({ cwd, projectTrusted: false, pickers });
		await handleInput("/rules add be excellent to each other", undefined, deps);
		const content = readFileSync(join(cwd, ".cast", "rules.md"), "utf-8");
		expect(content).toContain("be excellent to each other");
		expect(noticeText(calls)).toContain("not active");
		rmSync(fakeHome, { recursive: true, force: true });
	});

	it("/rules shows numbered list of rules", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "cast-cmd-rules-list-"));
		const cwd = join(fakeHome, "project");
		mkdirSync(join(cwd, ".cast"), { recursive: true });
		writeFileSync(join(cwd, ".cast", "rules.md"), "1. First rule\n2. Second rule");
		try {
			const { deps, calls } = createFakeDeps({ cwd });
			await handleInput("/rules", undefined, deps);
			const notice = noticeText(calls);
			expect(notice).toContain("1. First rule");
			expect(notice).toContain("2. Second rule");
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("/rules list works the same as /rules", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "cast-cmd-rules-list-alias-"));
		const cwd = join(fakeHome, "project");
		mkdirSync(join(cwd, ".cast"), { recursive: true });
		writeFileSync(join(cwd, ".cast", "rules.md"), "1. A rule");
		try {
			const { deps, calls } = createFakeDeps({ cwd });
			await handleInput("/rules list", undefined, deps);
			expect(noticeText(calls)).toContain("1. A rule");
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("/rules shows hint when no rules exist", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "cast-cmd-rules-empty-"));
		const cwd = join(fakeHome, "project");
		const { deps, calls } = createFakeDeps({ cwd });
		await handleInput("/rules", undefined, deps);
		expect(noticeText(calls)).toContain("No rules yet");
		rmSync(fakeHome, { recursive: true, force: true });
	});

	it("/rules delete removes picked rule and renumbers", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "cast-cmd-rules-delete-"));
		const cwd = join(fakeHome, "project");
		mkdirSync(join(cwd, ".cast"), { recursive: true });
		writeFileSync(join(cwd, ".cast", "rules.md"), "1. First\n2. Second\n3. Third");
		try {
			// pick scope "local", then rule 2, then Esc
			let callCount = 0;
			const pickers: Pickers = {
				pickOption: async () => {
					const c = callCount++;
					if (c === 0) return "local";
					if (c === 1) return 2;
					return null;
				},
				promptText: async () => null,
				log: () => {},
			};
			const { deps, calls } = createFakeDeps({ cwd, pickers });
			await handleInput("/rules delete", undefined, deps);
			const content = readFileSync(join(cwd, ".cast", "rules.md"), "utf-8");
			expect(content).toBe("1. First\n2. Third");
			const lastNotice = String(calls.showNotice?.at(-1)?.[0] ?? "");
			expect(lastNotice).toContain("1 local rule(s)");
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("/rules delete allows multiple deletions in one session", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "cast-cmd-rules-delete-multi-"));
		const cwd = join(fakeHome, "project");
		mkdirSync(join(cwd, ".cast"), { recursive: true });
		writeFileSync(join(cwd, ".cast", "rules.md"), "1. A\n2. B\n3. C");
		try {
			// pick scope "local", then rule 1, then rule 1 again (B shifted up), then Esc
			let callCount = 0;
			const pickers: Pickers = {
				pickOption: async () => {
					if (callCount++ === 0) return "local";
					return callCount <= 3 ? 1 : null;
				},
				promptText: async () => null,
				log: () => {},
			};
			const { deps, calls } = createFakeDeps({ cwd, pickers });
			await handleInput("/rules delete", undefined, deps);
			const content = readFileSync(join(cwd, ".cast", "rules.md"), "utf-8");
			expect(content).toBe("1. C");
			const lastNotice = String(calls.showNotice?.at(-1)?.[0] ?? "");
			expect(lastNotice).toContain("2 local rule(s)");
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("/rules delete with Esc on first pick shows no deletions", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "cast-cmd-rules-delete-cancel-"));
		const cwd = join(fakeHome, "project");
		mkdirSync(join(cwd, ".cast"), { recursive: true });
		writeFileSync(join(cwd, ".cast", "rules.md"), "1. Keep me");
		try {
			// pick scope "local", then Esc on rule picker
			let callCount = 0;
			const pickers: Pickers = {
				pickOption: async () => (callCount++ === 0 ? "local" : null),
				promptText: async () => null,
				log: () => {},
			};
			const { deps, calls } = createFakeDeps({ cwd, pickers });
			await handleInput("/rules delete", undefined, deps);
			const content = readFileSync(join(cwd, ".cast", "rules.md"), "utf-8");
			expect(content).toBe("1. Keep me");
			expect(noticeText(calls)).toContain("No rules deleted");
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("/rules delete with no rules shows message", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "cast-cmd-rules-delete-empty-"));
		const cwd = join(fakeHome, "project");
		mkdirSync(join(cwd, ".cast"), { recursive: true });
		writeFileSync(join(cwd, ".cast", "rules.md"), "");
		try {
			let callCount = 0;
			const pickers: Pickers = {
				pickOption: async () => (callCount++ === 0 ? "local" : null),
				promptText: async () => null,
				log: () => {},
			};
			const { deps, calls } = createFakeDeps({ cwd, pickers });
			await handleInput("/rules delete", undefined, deps);
			expect(noticeText(calls)).toContain("No local rules to delete");
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("unknown /command submits to agent as text (e.g. file paths)", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/notreal", undefined, deps);
		expect(calls["agent.submit"]).toEqual([["/notreal"]]);
	});

	it("/steer without message while running enqueues empty string", async () => {
		const { deps, calls } = createFakeDeps({ running: true });
		await handleInput("/steer", undefined, deps);
		expect(calls["agent.steer"]).toEqual([[""]]);
	});

	it("empty input does nothing (no submit)", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("   ", undefined, deps);
		expect(calls["agent.submit"]).toBeUndefined();
		expect(calls.showNotice).toBeUndefined();
	});

	it("/permissions bypass with default current prompts confirmation (declined)", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/permissions bypass", undefined, deps);
		expect(calls.setPermissionMode).toBeUndefined();
		expect(noticeText(calls)).toContain("Cancelled");
	});

	it("/permissions default applies without warning", async () => {
		const { deps, calls } = createFakeDeps({ permissionMode: "bypass" });
		await handleInput("/permissions default", undefined, deps);
		expect(calls.setPermissionMode).toEqual([["default"]]);
	});
});
