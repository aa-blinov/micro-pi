/**
 * Eval runner — executes agent test cases and checks results.
 *
 * Each case is a prompt + expectations:
 * - Expected tools called (by name, in order or any order)
 * - Expected content in final response
 * - Expected content NOT in final response
 * - Expected tool results
 * - Max turns (tool call rounds)
 * - Timeout
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { type AgentEvent, runAgentLoop } from "../src/core/loop.ts";
import { findPersona } from "../src/core/personas.ts";

// ============================================================================
// Case definition
// ============================================================================

/** A single tool invocation observed during a run. */
export interface ObservedToolCall {
	name: string;
	args: Record<string, unknown>;
}

/** Context passed to a case's `verify` hook after the run completes. */
export interface VerifyContext {
	/** Final assistant response text. */
	response: string;
	/** Working directory the agent ran in. */
	cwd: string;
	/** Every tool call the agent made, in order, with parsed arguments. */
	toolCalls: ObservedToolCall[];
	/** Number of tool-call rounds. */
	turns: number;
}

export interface EvalCase {
	/** Unique case ID */
	id: string;
	/** Human-readable description */
	description: string;
	/** User prompt */
	prompt: string;
	/** Model to use (overrides default) */
	model?: string;
	/**
	 * Runs before the prompt. Used to (re)create fixture files on disk (see
	 * `evals/fixtures.ts`) so grounded checks in `verify` have known starting state.
	 */
	setup?: () => void | Promise<void>;
	/** Expectations */
	expect: {
		/** Final response must contain ALL of these strings */
		containsAll?: string[];
		/** Final response must contain ANY of these strings */
		containsAny?: string[];
		/** Final response must NOT contain any of these strings */
		containsNone?: string[];
		/** Tools that must be called (by name) */
		toolsCalled?: string[];
		/** Tools that must NOT be called */
		toolsNotCalled?: string[];
		/** Exact tool call sequence (ordered) */
		toolSequence?: string[];
		/** Minimum number of calls per tool name (e.g. bash called at least twice) */
		toolCallCounts?: Record<string, number>;
		/** Max number of tool call rounds */
		maxTurns?: number;
		/** Agent must not error out */
		noErrors?: boolean;
		/**
		 * Grounded check run after all other expectations. Use this for anything that
		 * needs to inspect real state (files on disk, command execution output) rather
		 * than trusting the model's self-reported response text. Return an error
		 * message to fail the case, or undefined/empty string to pass.
		 */
		verify?: (ctx: VerifyContext) => string | undefined | Promise<string | undefined>;
	};
	/** Timeout in ms (default: 60000) */
	timeout?: number;
}

// ============================================================================
// Run result
// ============================================================================

/**
 * Serializable snapshot of what a case expected — everything from `EvalCase.expect`
 * except `verify` itself (a function, can't round-trip through JSON), replaced with
 * a boolean flag. Exists so saved result files are self-documenting: you can see
 * what a case was checking for without cross-referencing the case source file.
 */
export interface ExpectedSummary {
	containsAll?: string[];
	containsAny?: string[];
	containsNone?: string[];
	toolsCalled?: string[];
	toolsNotCalled?: string[];
	toolSequence?: string[];
	toolCallCounts?: Record<string, number>;
	maxTurns?: number;
	noErrors?: boolean;
	hasGroundedVerify: boolean;
}

export interface RunResult {
	caseId: string;
	description: string;
	model: string;
	passed: boolean;
	duration: number;
	toolsCalled: string[];
	toolCalls: ObservedToolCall[];
	turns: number;
	response: string;
	thinking: string;
	errors: string[];
	failedChecks: string[];
	expectedSummary: ExpectedSummary;
}

// ============================================================================
// Runner
// ============================================================================

export interface RunnerOptions {
	model: string;
	cwd: string;
	verbose?: boolean;
	/** Named entry from settings `providers[]`; defaults to the active provider. */
	provider?: string;
	/** Persona whose system prompt the agent runs with; defaults to "senior". */
	persona?: string;
}

/**
 * Provider connection for eval runs — the user's own cast settings.
 * With no name, the active `providerUrl`/`apiKey` pair is used; with a
 * name, the matching entry from `providers[]` is picked.
 */
function loadConnection(providerName?: string): { baseURL: string; apiKey: string } {
	const settings = JSON.parse(readFileSync(join(homedir(), ".cast", "settings.json"), "utf-8")) as {
		providerUrl?: string;
		apiKey?: string;
		providers?: Array<{ name: string; url: string; apiKey: string }>;
	};
	if (providerName) {
		const p = settings.providers?.find((x) => x.name === providerName);
		if (!p) {
			const known = settings.providers?.map((x) => x.name).join(", ") || "none";
			throw new Error(`Provider "${providerName}" not found in ~/.cast/settings.json (known: ${known})`);
		}
		return { baseURL: p.url, apiKey: p.apiKey };
	}
	if (!settings.providerUrl || !settings.apiKey) {
		throw new Error("evals need providerUrl and apiKey in ~/.cast/settings.json");
	}
	return { baseURL: settings.providerUrl, apiKey: settings.apiKey };
}

export async function runCase(evalCase: EvalCase, options: RunnerOptions): Promise<RunResult> {
	const config = loadConfig(loadConnection(options.provider));
	const model = evalCase.model ?? options.model;
	const timeout = evalCase.timeout ?? 60_000;

	const events: AgentEvent[] = [];
	const toolsCalled: string[] = [];
	const toolCalls: ObservedToolCall[] = [];
	let response = "";
	let thinking = "";
	let turns = 0;
	const errors: string[] = [];

	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeout);

	const startTime = Date.now();

	try {
		await evalCase.setup?.();

		// Use a real persona prompt so evals exercise the same system prompt
		// (including the shared tools-edit guidance) the shipping agent gets —
		// a bare stub here silently unplugged prompts/tools-edit.md from every
		// eval run. The persona is selectable so results can be compared
		// across personas; an unknown name fails loudly rather than silently
		// benchmarking the wrong prompt.
		const personaName = options.persona ?? "senior";
		const personaPrompt = findPersona(personaName)?.systemPrompt;
		if (!personaPrompt) {
			throw new Error(`Persona "${personaName}" not found — check prompts/personas/ and ~/.cast/personas/.`);
		}
		await runAgentLoop([{ role: "user", content: evalCase.prompt }], {
			config,
			model,
			cwd: options.cwd,
			systemPrompt: personaPrompt,
			signal: ac.signal,
			onEvent: (event) => {
				events.push(event);

				if (event.type === "tool_start") {
					toolsCalled.push(event.name);
					let args: Record<string, unknown> = {};
					try {
						args = JSON.parse(event.args);
					} catch {
						// leave empty — args string wasn't valid JSON
					}
					toolCalls.push({ name: event.name, args });
				}
				if (event.type === "assistant_message") {
					response = event.content;
					thinking = event.thinking;
				}
				if (event.type === "turn_end") {
					turns++;
				}
				if (event.type === "error") {
					errors.push(event.message);
				}
			},
		});
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}

	clearTimeout(timer);
	const duration = Date.now() - startTime;

	// Check expectations
	const failedChecks: string[] = [];
	const expect = evalCase.expect;

	// containsAll
	if (expect.containsAll) {
		for (const text of expect.containsAll) {
			if (!response.includes(text)) {
				failedChecks.push(`Response missing: "${text}"`);
			}
		}
	}

	// containsAny
	if (expect.containsAny) {
		const found = expect.containsAny.some((text) => response.includes(text));
		if (!found) {
			failedChecks.push(`Response missing any of: [${expect.containsAny.map((s) => `"${s}"`).join(", ")}]`);
		}
	}

	// containsNone
	if (expect.containsNone) {
		for (const text of expect.containsNone) {
			if (response.includes(text)) {
				failedChecks.push(`Response should not contain: "${text}"`);
			}
		}
	}

	// toolsCalled
	if (expect.toolsCalled) {
		for (const tool of expect.toolsCalled) {
			if (!toolsCalled.includes(tool)) {
				failedChecks.push(`Tool not called: ${tool}`);
			}
		}
	}

	// toolsNotCalled
	if (expect.toolsNotCalled) {
		for (const tool of expect.toolsNotCalled) {
			if (toolsCalled.includes(tool)) {
				failedChecks.push(`Tool should not be called: ${tool}`);
			}
		}
	}

	// toolSequence
	if (expect.toolSequence) {
		const actual = toolsCalled.join(",");
		const expected = expect.toolSequence.join(",");
		if (actual !== expected) {
			failedChecks.push(`Tool sequence: expected [${expected}], got [${actual}]`);
		}
	}

	// toolCallCounts
	if (expect.toolCallCounts) {
		for (const [tool, min] of Object.entries(expect.toolCallCounts)) {
			const actual = toolsCalled.filter((t) => t === tool).length;
			if (actual < min) {
				failedChecks.push(`Tool "${tool}" called ${actual} time(s), expected at least ${min}`);
			}
		}
	}

	// maxTurns
	if (expect.maxTurns !== undefined && turns > expect.maxTurns) {
		failedChecks.push(`Too many turns: expected <= ${expect.maxTurns}, got ${turns}`);
	}

	// noErrors
	if (expect.noErrors && errors.length > 0) {
		failedChecks.push(`Errors occurred: ${errors.join("; ")}`);
	}

	// verify — grounded check against real state (disk, execution output)
	if (expect.verify) {
		try {
			const verifyError = await expect.verify({ response, cwd: options.cwd, toolCalls, turns });
			if (verifyError) failedChecks.push(`Verify failed: ${verifyError}`);
		} catch (error) {
			failedChecks.push(`Verify threw: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const passed = failedChecks.length === 0;

	const expectedSummary: ExpectedSummary = {
		containsAll: expect.containsAll,
		containsAny: expect.containsAny,
		containsNone: expect.containsNone,
		toolsCalled: expect.toolsCalled,
		toolsNotCalled: expect.toolsNotCalled,
		toolSequence: expect.toolSequence,
		toolCallCounts: expect.toolCallCounts,
		maxTurns: expect.maxTurns,
		noErrors: expect.noErrors,
		hasGroundedVerify: expect.verify !== undefined,
	};

	return {
		caseId: evalCase.id,
		description: evalCase.description,
		model,
		passed,
		duration,
		toolsCalled,
		toolCalls,
		turns,
		response,
		thinking,
		errors,
		failedChecks,
		expectedSummary,
	};
}

// ============================================================================
// Run all cases
// ============================================================================

export interface SuiteResult {
	/** Default model requested for the suite (individual cases may override via `EvalCase.model`). */
	model: string;
	total: number;
	passed: number;
	failed: number;
	duration: number;
	results: RunResult[];
}

export async function runSuite(
	cases: EvalCase[],
	options: RunnerOptions & { concurrency?: number },
): Promise<SuiteResult> {
	const concurrency = options.concurrency ?? 10;
	const results: RunResult[] = new Array(cases.length);
	const startTime = Date.now();
	let completed = 0;

	// Run cases in parallel with concurrency limit
	const executing = new Set<Promise<void>>();

	for (let i = 0; i < cases.length; i++) {
		const idx = i;
		const evalCase = cases[i]!;

		const task = (async () => {
			const result = await runCase(evalCase, options);
			results[idx] = result;
			completed++;

			if (options.verbose) {
				const status = result.passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
				const tools = result.toolsCalled.length > 0 ? ` [${result.toolsCalled.join(", ")}]` : "";
				const progress = `[${completed}/${cases.length}]`;
				console.log(
					`  ${progress} ${evalCase.id}: ${status} (${result.duration}ms, ${result.turns} turns)${tools}`,
				);

				if (!result.passed) {
					for (const check of result.failedChecks) {
						console.log(`        \x1b[31m✗ ${check}\x1b[0m`);
					}
				}
			}
		})();

		executing.add(task);
		task.then(() => executing.delete(task));

		// Wait if we hit the concurrency limit
		if (executing.size >= concurrency) {
			await Promise.race(executing);
		}
	}

	// Wait for all remaining tasks
	await Promise.all(executing);

	const duration = Date.now() - startTime;
	const passed = results.filter((r) => r.passed).length;

	return {
		model: options.model,
		total: results.length,
		passed,
		failed: results.length - passed,
		duration,
		results,
	};
}

// ============================================================================
// Report
// ============================================================================

export function printReport(suite: SuiteResult): void {
	console.log("\n" + "=".repeat(60));
	console.log(`EVAL RESULTS: ${suite.passed}/${suite.total} passed (${suite.duration}ms)`);
	console.log("=".repeat(60));

	if (suite.failed > 0) {
		console.log("\nFailed cases:");
		for (const result of suite.results.filter((r) => !r.passed)) {
			console.log(`  \x1b[31m✗ ${result.caseId}\x1b[0m — ${result.description}`);
			for (const check of result.failedChecks) {
				console.log(`    - ${check}`);
			}
		}
	}

	console.log("\nSummary:");
	for (const result of suite.results) {
		const status = result.passed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
		console.log(
			`  ${status} ${result.caseId} (${result.duration}ms, ${result.turns} turns, tools: [${result.toolsCalled.join(", ")}])`,
		);
	}
}

/**
 * Save results to JSON for regression tracking.
 */
export function saveResults(suite: SuiteResult, path: string): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	const data = {
		timestamp: new Date().toISOString(),
		model: suite.model,
		total: suite.total,
		passed: suite.passed,
		failed: suite.failed,
		duration: suite.duration,
		cases: suite.results.map((r) => ({
			id: r.caseId,
			description: r.description,
			model: r.model,
			passed: r.passed,
			duration: r.duration,
			turns: r.turns,
			toolsCalled: r.toolsCalled,
			expected: r.expectedSummary,
			failedChecks: r.failedChecks,
			errors: r.errors,
			responsePreview: r.response.slice(0, 500),
		})),
	};

	writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}
