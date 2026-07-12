import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
		addDisplayMessage: track("agent.addDisplayMessage"),
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
			source: "builtin",
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
		rulesLazySuffix: "",
		setRulesLazySuffix: track("setRulesLazySuffix"),
		directoryRules: [],
		setDirectoryRules: track("setDirectoryRules"),
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
		subagentModel: undefined,
		setSubagentModel: track("setSubagentModel"),
		webToolsEnabled: true,
		setWebToolsEnabled: track("setWebToolsEnabled"),
		planMode: false,
		setPlanMode: track("setPlanMode"),
		planModel: undefined,
		setPlanModel: track("setPlanModel"),
		setReasoningMeta: track("setReasoningMeta"),
		personaOptions: {},
		setPersonaOptions: track("setPersonaOptions"),
		...overrides,
	};

	return { deps, calls };
}

function noticeText(calls: Calls): string {
	return String(calls.showNotice?.[0]?.[0] ?? "");
}

function displayMessageText(calls: Calls, index = 1): string {
	const arg = calls["agent.addDisplayMessage"]?.[index]?.[0] as { role?: string; content?: string } | undefined;
	return String(arg?.content ?? "");
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

	it("/s <msg> is an alias for /steer", async () => {
		const { deps, calls } = createFakeDeps({ running: true });
		await handleInput("/s fix the bug", undefined, deps);
		expect(calls["agent.steer"]).toEqual([["fix the bug"]]);
	});

	it("/q <msg> is an alias for /queue", async () => {
		const { deps, calls } = createFakeDeps({ running: true });
		await handleInput("/q next step", undefined, deps);
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

	it("/help lists command names", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/help", undefined, deps);
		expect(displayMessageText(calls)).toContain("/clear");
		expect(displayMessageText(calls)).toContain("/model");
		expect(displayMessageText(calls)).toContain("/quit");
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
		expect(displayMessageText(calls)).toContain("No skills");
	});

	it("/mcp reports none connected when empty", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/mcp", undefined, deps);
		expect(displayMessageText(calls)).toContain("No MCP");
	});

	it("unknown /command submits to agent as text (e.g. file paths)", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/notreal", undefined, deps);
		expect(calls["agent.submit"]).toEqual([["/notreal"]]);
	});

	it("/steer without a message shows usage and does not enqueue", async () => {
		const { deps, calls } = createFakeDeps({ running: true });
		await handleInput("/steer", undefined, deps);
		expect(calls["agent.steer"]).toBeUndefined();
		expect(noticeText(calls)).toContain("Usage");
	});

	it("/steer while idle sends the message as a normal prompt", async () => {
		const { deps, calls } = createFakeDeps({ running: false });
		await handleInput("/steer do the thing", undefined, deps);
		expect(calls["agent.steer"]).toBeUndefined();
		expect(calls["agent.submit"]).toEqual([["do the thing", undefined]]);
	});

	it("/queue without a message shows usage and does not enqueue or submit", async () => {
		const { deps, calls } = createFakeDeps({ running: true });
		await handleInput("/queue", undefined, deps);
		expect(calls["agent.followUp"]).toBeUndefined();
		expect(calls["agent.submit"]).toBeUndefined();
		expect(noticeText(calls)).toContain("Usage");
	});

	it("/queue while idle runs the message immediately instead of queueing", async () => {
		const { deps, calls } = createFakeDeps({ running: false });
		await handleInput("/queue next step", undefined, deps);
		expect(calls["agent.followUp"]).toBeUndefined();
		expect(calls["agent.submit"]).toEqual([["next step", undefined]]);
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

describe("SLASH_COMMANDS", () => {
	it("is sorted alphabetically by name (palette renders it verbatim)", async () => {
		const { SLASH_COMMANDS } = await import("../src/ui/commands.ts");
		const names = SLASH_COMMANDS.map((c) => c.name);
		expect(names).toEqual([...names].sort());
	});
});

describe("plan mode commands", () => {
	// Real HOME must stay untouched: /new saves session files and /build reads
	// ~/.cast/plans — both resolve through homedir(), which honors $HOME.
	let realHome: string | undefined;
	beforeEach(() => {
		realHome = process.env.HOME;
		process.env.HOME = join(tmpdir(), `cast-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	});
	afterEach(() => {
		if (process.env.HOME) rmSync(process.env.HOME, { recursive: true, force: true });
		process.env.HOME = realHome;
	});

	it("/plan enters plan mode", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/plan", undefined, deps);
		expect(calls.setPlanMode?.[0]).toEqual([true]);
		expect(noticeText(calls)).toContain("Plan mode: ON");
	});

	it("/plan is a no-op when already in plan mode", async () => {
		const { deps, calls } = createFakeDeps({ planMode: true });
		await handleInput("/plan", undefined, deps);
		expect(calls.setPlanMode).toBeUndefined();
		expect(noticeText(calls)).toContain("Already in plan mode");
	});

	it("/plan and /build are rejected while the agent is running", async () => {
		for (const cmd of ["/plan", "/build"]) {
			const { deps, calls } = createFakeDeps({ running: true, planMode: cmd === "/build" });
			await handleInput(cmd, undefined, deps);
			expect(calls.setPlanMode, cmd).toBeUndefined();
			expect(noticeText(calls), cmd).toContain("Agent running");
		}
	});

	it("/build exits plan mode (no plan on disk: full-toolset notice)", async () => {
		const { deps, calls } = createFakeDeps({ planMode: true });
		await handleInput("/build", undefined, deps);
		expect(calls.setPlanMode?.[0]).toEqual([false]);
		expect(noticeText(calls)).toContain("full toolset restored");
	});

	it("/build outside plan mode explains itself", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/build", undefined, deps);
		expect(calls.setPlanMode).toBeUndefined();
		expect(noticeText(calls)).toContain("Not in plan mode");
	});

	it("/new resets the mode to build", async () => {
		const { deps, calls } = createFakeDeps({ planMode: true });
		await handleInput("/new", undefined, deps);
		expect(calls.setPlanMode?.[0]).toEqual([false]);
	});

	it("/plan-model cancelled leaves the override unchanged", async () => {
		const { deps, calls } = createFakeDeps({ planModel: "expensive-model" });
		await handleInput("/plan-model", undefined, deps);
		expect(calls.setPlanModel).toBeUndefined();
		expect(noticeText(calls)).toContain("Cancelled");
	});

	it("/plan-model off clears the override so plan mode uses the main model", async () => {
		const { deps, calls } = createFakeDeps({ planModel: "expensive-model" });
		await handleInput("/plan-model off", undefined, deps);
		expect(calls.setPlanModel?.[0]).toEqual([undefined]);
		expect(noticeText(calls)).toContain("plan mode uses the main model");
	});
});
