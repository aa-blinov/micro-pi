#!/usr/bin/env node --import tsx

/**
 * Eval runner CLI.
 *
 * Usage:
 *   node --import tsx evals/run.ts [options]
 *
 * Options:
 *   --model, -m <model>    Model to use (required)
 *   --cases, -c <filter>   Run only cases matching this prefix
 *   --verbose, -v          Show per-case output
 *   --save, -s <path>      Save results to JSON file
 *   --list                 List available cases
 */

import { resolve } from "node:path";
import { basicCases } from "./cases/basic.ts";
import { cleanupFixtures } from "./fixtures.ts";
import { type EvalCase, printReport, type RunnerOptions, runSuite, saveResults } from "./runner.ts";

// ============================================================================
// Collect all cases
// ============================================================================

const allCases: EvalCase[] = [...basicCases];

// Fixture files live under a per-process temp dir (see evals/fixtures.ts) — wipe
// it on every exit path (success, --list, error, Ctrl+C) so runs don't leave
// garbage behind in /tmp.
process.on("exit", cleanupFixtures);

// ============================================================================
// CLI
// ============================================================================

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	let model: string | undefined;
	let caseFilter: string | undefined;
	let verbose = false;
	let savePath: string | undefined;
	let listOnly = false;
	let concurrency = 10;

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--model":
			case "-m":
				model = args[++i];
				break;
			case "--cases":
			case "-c":
				caseFilter = args[++i];
				break;
			case "--verbose":
			case "-v":
				verbose = true;
				break;
			case "--save":
			case "-s":
				savePath = args[++i];
				break;
			case "--concurrency":
			case "-j":
				concurrency = parseInt(args[++i] ?? "10", 10);
				break;
			case "--list":
				listOnly = true;
				break;
			case "--help":
			case "-h":
				printHelp();
				return;
		}
	}

	if (listOnly) {
		console.log("Available eval cases:\n");
		for (const c of allCases) {
			console.log(`  ${c.id.padEnd(25)} ${c.description}`);
		}
		console.log(`\nTotal: ${allCases.length} cases`);
		return;
	}

	if (!model) {
		console.error("Error: --model is required");
		console.error("Usage: node --import tsx evals/run.ts -m <model> [-v] [-s results.json]");
		process.exit(1);
	}

	// Filter cases
	let cases = allCases;
	if (caseFilter) {
		cases = allCases.filter((c) => c.id.startsWith(caseFilter));
		if (cases.length === 0) {
			console.error(`No cases match filter: ${caseFilter}`);
			console.error("Use --list to see available cases.");
			process.exit(1);
		}
	}

	// Set PROVIDER_BASE_URL and PROVIDER_API_KEY if not set
	if (!process.env.PROVIDER_BASE_URL) {
		process.env.PROVIDER_BASE_URL = "https://openrouter.ai/api/v1";
	}

	const cwd = resolve(".");
	const options: RunnerOptions & { concurrency: number } = { model, cwd, verbose, concurrency };

	console.log(`\nRunning ${cases.length} eval cases with model: ${model} (concurrency: ${concurrency})\n`);

	const suite = await runSuite(cases, options);

	printReport(suite);

	if (savePath) {
		saveResults(suite, savePath);
		console.log(`\nResults saved to: ${savePath}`);
	}

	// Exit with failure if any case failed
	if (suite.failed > 0) {
		process.exit(1);
	}
}

function printHelp(): void {
	console.log(`
eval-runner — Run agent eval cases and track regressions

Usage:
  node --import tsx evals/run.ts -m <model> [options]

Options:
  --model, -m <model>    Model to use (required)
  --cases, -c <filter>   Run only cases matching this prefix
  --verbose, -v          Show per-case output
  --concurrency, -j <n>  Parallel case execution (default: 10)
  --save, -s <path>      Save results to JSON file
  --list                 List available cases
  --help, -h             Show this help

Environment variables:
  PROVIDER_BASE_URL      OpenAI-compatible endpoint (default: OpenRouter)
  PROVIDER_API_KEY       API key

Examples:
  # Run all cases
  node --import tsx evals/run.ts -m qwen/qwen3.7-max -v

  # Run only basic cases
  node --import tsx evals/run.ts -m gpt-4o -c basic -v

  # Save results for regression tracking
  node --import tsx evals/run.ts -m qwen/qwen3.7-max -v -s evals/results/latest.json

  # List available cases
  node --import tsx evals/run.ts --list
`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
