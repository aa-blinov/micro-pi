import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import type { McpSetupResult } from "../src/core/mcp.ts";
import type { Persona } from "../src/core/personas.ts";
import { createAgentRunner } from "../src/core/runner.ts";
import { createSession } from "../src/core/session.ts";
import type { StartupResult } from "../src/core/startup.ts";

// submit() fires runAgentLoop in the background (fire-and-forget) — stub it
// so bridge tests don't need a live provider, but keep everything else
// (MessageQueue, event types) from the real module.
const runAgentLoop = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/core/loop.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/loop.ts")>();
	return { ...actual, runAgentLoop: (...args: unknown[]) => runAgentLoop(...args) };
});

const { createWebBridge } = await import("../src/web/bridge.ts");

const testConfig: AppConfig = {
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
};

const emptyMcp: McpSetupResult = {
	toolIndex: new Map(),
	toolDefinitions: [],
	connections: [],
	diagnostics: [],
	allServerNames: [],
};

function makePersona(overrides: Partial<Persona> = {}): Persona {
	return {
		name: "coding",
		label: "Coding",
		description: "Reads files, runs commands, edits code",
		systemPrompt: "You are the coding persona.",
		source: "builtin",
		filePath: "/builtin/coding.md",
		subagents: false,
		...overrides,
	} as Persona;
}

describe("web bridge", () => {
	let fakeHome: string;
	let realHome: string | undefined;
	let cwd: string;

	beforeEach(() => {
		runAgentLoop.mockClear();
		realHome = process.env.HOME;
		fakeHome = mkdtempSync(join(tmpdir(), "cast-web-bridge-test-"));
		process.env.HOME = fakeHome;
		cwd = fakeHome;
	});

	afterEach(() => {
		process.env.HOME = realHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	function makeResult(overrides: Partial<StartupResult> = {}): StartupResult {
		const coding = makePersona();
		const senior = makePersona({ name: "senior", label: "Senior", systemPrompt: "You are the senior persona." });
		return {
			config: testConfig,
			cwd,
			systemPrompt: "unused — bridge rebuilds its own per-session prompt",
			session: createSession("gpt-4o", cwd),
			runner: createAgentRunner(),
			permissionMode: "default",
			mcpResult: emptyMcp,
			skills: [],
			persona: coding,
			personaOptions: {} as StartupResult["personaOptions"],
			personas: [coding, senior],
			subagentPrompts: [],
			confirmBash: async () => true,
			projectDeps: {} as StartupResult["projectDeps"],
			projectTrusted: true,
			contextFilesSuffix: "",
			rulesSuffix: "",
			rulesLazySuffix: "",
			directoryRules: [],
			activeAutoRules: [],
			skillsPromptSuffix: "",
			sshHosts: [],
			resumed: false,
			...overrides,
		};
	}

	it("builds a persona-specific system prompt at session creation", () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession("senior");
		expect(ws.systemPrompt).toContain("You are the senior persona.");
	});

	it("/persona with no arg reports the current persona without changing anything", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		const res = await bridge.executeCommand(ws.id, "/persona");
		expect(res).toEqual({ ok: true, result: { persona: "coding" } });
	});

	it("/persona <name> switches persona and rebuilds the system prompt", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		const res = await bridge.executeCommand(ws.id, "/persona senior");
		expect(res.ok).toBe(true);
		expect(ws.session.persona).toBe("senior");
		expect(ws.systemPrompt).toContain("You are the senior persona.");
	});

	it("/persona <unknown> fails without mutating session state", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		const before = ws.systemPrompt;
		const res = await bridge.executeCommand(ws.id, "/persona ghost");
		expect(res.ok).toBe(false);
		expect(ws.session.persona).toBe("coding");
		expect(ws.systemPrompt).toBe(before);
	});

	it("/model <name> updates the session model", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		const res = await bridge.executeCommand(ws.id, "/model gpt-5");
		expect(res).toEqual({ ok: true, result: { model: "gpt-5" } });
		expect(ws.session.model).toBe("gpt-5");
	});

	it("/model and /persona are rejected while the agent is running", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		ws.status = "running";
		expect((await bridge.executeCommand(ws.id, "/model gpt-5")).ok).toBe(false);
		expect((await bridge.executeCommand(ws.id, "/persona senior")).ok).toBe(false);
	});

	it("/steer while idle just sends the message as a normal turn", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		const res = await bridge.executeCommand(ws.id, "/steer hello");
		expect(res).toEqual({ ok: true, result: "Sent" });
		expect(runAgentLoop).toHaveBeenCalledTimes(1);
	});

	it("/steer while running enqueues into the steering queue instead of starting a new turn", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		ws.status = "running";
		const res = await bridge.executeCommand(ws.id, "/steer hello");
		expect(res).toEqual({ ok: true, result: "Steered into the running turn" });
		expect(runAgentLoop).not.toHaveBeenCalled();
		expect(ws.runner.steeringQueue.hasItems()).toBe(true);
	});

	it("/queue while running enqueues a follow-up; /queue-reset clears it", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		ws.status = "running";
		await bridge.executeCommand(ws.id, "/queue after this turn");
		expect(ws.runner.followUpQueue.hasItems()).toBe(true);
		await bridge.executeCommand(ws.id, "/queue-reset");
		expect(ws.runner.followUpQueue.hasItems()).toBe(false);
	});

	it("/steer and /queue require a message", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		expect((await bridge.executeCommand(ws.id, "/steer")).ok).toBe(false);
		expect((await bridge.executeCommand(ws.id, "/queue")).ok).toBe(false);
	});

	it("suggestCommand returns subcommands for bare commands", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();

		const mcpSuggestions = bridge.suggestCommand(ws.id, "/mcp");
		expect(mcpSuggestions.map((s) => s.value)).toEqual(["list", "enable", "disable", "uninstall", "help"]);

		const skillsSuggestions = bridge.suggestCommand(ws.id, "/skills");
		expect(skillsSuggestions.map((s) => s.value)).toEqual(["list", "enable", "disable", "uninstall", "help"]);

		const pluginSuggestions = bridge.suggestCommand(ws.id, "/plugin");
		expect(pluginSuggestions.map((s) => s.value)).toEqual([
			"list",
			"install",
			"uninstall",
			"enable",
			"disable",
			"marketplace",
			"help",
		]);

		const permissionsSuggestions = bridge.suggestCommand(ws.id, "/permissions");
		expect(permissionsSuggestions.map((s) => s.value)).toEqual(["default", "bypass"]);

		const sshSuggestions = bridge.suggestCommand(ws.id, "/ssh");
		expect(sshSuggestions.map((s) => s.value)).toEqual(["list", "add", "remove"]);
	});

	it("suggestCommand returns empty for unknown commands", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		expect(bridge.suggestCommand(ws.id, "/unknown")).toEqual([]);
		expect(bridge.suggestCommand(ws.id, "/mcp enable unknown-server")).toEqual([]);
	});

	describe("SSE broadcast synchronicity", () => {
		it("delivers events to two listeners in the same synchronous tick", () => {
			const bridge = createWebBridge(makeResult());
			const ws = bridge.createSession();

			// Track which microtask tick each listener sees per event.
			// A microtask-based counter increments every time the event loop
			// yields. If broadcast were async, the two listeners would see
			// different tick values for at least one event.
			const counter = { value: 0 };
			let ticking = true;
			Promise.resolve().then(function tick() {
				counter.value++;
				if (ticking) Promise.resolve().then(tick);
			});

			const ticksAtListener1: number[] = [];
			const ticksAtListener2: number[] = [];
			const received1: unknown[] = [];
			const received2: unknown[] = [];

			bridge.subscribe(ws.id, (e) => {
				ticksAtListener1.push(counter.value);
				received1.push(e);
			});
			bridge.subscribe(ws.id, (e) => {
				ticksAtListener2.push(counter.value);
				received2.push(e);
			});

			// submit() fires runAgentLoop and broadcasts a status event —
			// grab the onEvent callback it passes in.
			bridge.submit(ws.id, "trigger");
			const loopConfig = runAgentLoop.mock.calls[0]?.[1] as {
				onEvent: (event: unknown) => void;
			};
			const onEvent = loopConfig.onEvent;

			// Clear the initial "status: running" event that submit() broadcast
			ticksAtListener1.length = 0;
			ticksAtListener2.length = 0;
			received1.length = 0;
			received2.length = 0;

			// Fire several events simulating a real LLM stream
			const events = [
				{ type: "token", text: "Hello" },
				{ type: "thinking", text: "reasoning..." },
				{ type: "token", text: " world" },
				{ type: "assistant_message", content: "Hello world", thinking: "reasoning..." },
				{ type: "usage", usage: { promptTokens: 10, completionTokens: 5 } },
				{ type: "end", reason: "stop" },
			];

			for (const event of events) {
				onEvent(event);
			}

			ticking = false;

			// Both listeners received every event
			expect(received1).toHaveLength(events.length);
			expect(received2).toHaveLength(events.length);

			// Events arrived in the same order
			for (let i = 0; i < events.length; i++) {
				expect(received1[i]).toBe(events[i]);
				expect(received2[i]).toBe(events[i]);
			}

			// The tick counter was identical for both listeners on every event
			// — proving no microtask ran between them (i.e. broadcast is sync).
			expect(ticksAtListener1).toEqual(ticksAtListener2);
		});

		it("a disconnected listener does not block delivery to remaining listeners", () => {
			const bridge = createWebBridge(makeResult());
			const ws = bridge.createSession();

			const goodEvents: unknown[] = [];

			// First listener throws (simulating a disconnected SSE client)
			bridge.subscribe(ws.id, () => {
				throw new Error("client disconnected");
			});
			// Second listener is healthy
			bridge.subscribe(ws.id, (e) => goodEvents.push(e));

			bridge.submit(ws.id, "trigger");
			const loopConfig = runAgentLoop.mock.calls[0]?.[1] as {
				onEvent: (event: unknown) => void;
			};

			// Clear the initial "status: running" from submit()
			goodEvents.length = 0;

			loopConfig.onEvent({ type: "token", text: "ok" });
			loopConfig.onEvent({ type: "end", reason: "stop" });

			// Healthy listener got both events despite the first one throwing
			expect(goodEvents).toHaveLength(2);
			expect(goodEvents[0]).toEqual({ type: "token", text: "ok" });
			expect(goodEvents[1]).toEqual({ type: "end", reason: "stop" });
		});

		it("subscribe receives current status immediately on connection", () => {
			const bridge = createWebBridge(makeResult());
			const ws = bridge.createSession();

			// Simulate a running session
			ws.status = "running";

			// The SSE endpoint in server.ts sends current status via a direct
			// res.write before subscribing — here we verify the bridge exposes
			// the status so that path can read it.
			const summary = bridge.listSessions();
			const ours = summary.find((s) => s.id === ws.id);
			expect(ours?.status).toBe("running");
		});
	});

	describe("background bash tasks", () => {
		it("submit() threads backgroundBash into the LoopConfig passed to runAgentLoop", () => {
			const bridge = createWebBridge(makeResult());
			const ws = bridge.createSession();
			bridge.submit(ws.id, "hello");
			expect(runAgentLoop).toHaveBeenCalledTimes(1);
			const loopConfig = runAgentLoop.mock.calls[0]?.[1] as { backgroundBash?: unknown };
			expect(loopConfig.backgroundBash).toBe(ws.backgroundBash);
		});

		it("closeSession() kills any still-running background tasks", () => {
			const bridge = createWebBridge(makeResult());
			const ws = bridge.createSession();
			const killAllSpy = vi.spyOn(ws.backgroundBash.registry, "killAll");
			bridge.closeSession(ws.id);
			expect(killAllSpy).toHaveBeenCalledTimes(1);
		});

		// The whole point of the feature: a background task finishing while the
		// session is fully idle (no turn to steer into) still gets the model's
		// attention — via the registry's onIdleWake, wired to submit() at session
		// construction (bridge.ts's makeBackgroundBash), starting a fresh turn.
		it("a background task finishing while idle wakes a fresh turn with a <system-reminder>", async () => {
			const bridge = createWebBridge(makeResult());
			const ws = bridge.createSession();

			runAgentLoop.mockImplementationOnce(async (messages: unknown[]) => messages);
			bridge.submit(ws.id, "hello");
			await new Promise((r) => setTimeout(r, 0));
			expect(ws.status).toBe("idle");

			runAgentLoop.mockClear();
			runAgentLoop.mockImplementationOnce(async (messages: unknown[]) => messages);
			ws.backgroundBash.registry.start("echo bg-wake-marker", cwd, testConfig, 5, ws.backgroundBash);
			await new Promise((r) => setTimeout(r, 500));

			expect(runAgentLoop).toHaveBeenCalledTimes(1);
			const lastMessage = ws.session.messages.at(-1);
			expect(lastMessage?.role).toBe("user");
			expect(String(lastMessage?.content)).toContain("<system-reminder>");
			expect(String(lastMessage?.content)).toContain("bg-wake-marker");
		});

		it("a background task finishing while a turn is still running enqueues onto followUpQueue instead", async () => {
			const bridge = createWebBridge(makeResult());
			const ws = bridge.createSession();
			ws.runner.startRun(new AbortController());

			ws.backgroundBash.registry.start("echo bg-followup-marker", cwd, testConfig, 5, ws.backgroundBash);
			await new Promise((r) => setTimeout(r, 500));

			expect(runAgentLoop).not.toHaveBeenCalled();
			expect(ws.runner.followUpQueue.hasItems()).toBe(true);
			const [queued] = ws.runner.followUpQueue.drain();
			expect(String(queued?.content)).toContain("bg-followup-marker");
		});
	});
});
