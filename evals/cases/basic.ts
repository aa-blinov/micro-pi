/**
 * Basic eval cases — fundamental agent capabilities.
 *
 * Where possible, checks are grounded in real state (files on disk, command
 * execution output) rather than the model's self-reported response text —
 * a model can claim it wrote a file or fixed a bug without actually doing so,
 * and a keyword match on the response can't catch that.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDir, fixturePath, writeFixture } from "../fixtures.ts";
import type { EvalCase } from "../runner.ts";

export const basicCases: EvalCase[] = [
	// ── No-tool baseline ─────────────────────────────────────────────────────

	{
		id: "simple-math",
		description: "Agent answers a simple math question without tools",
		prompt: "What is 2 + 2?",
		expect: {
			containsAny: ["4", "four"],
			toolsNotCalled: ["bash", "read", "write", "edit", "find", "grep", "ls"],
			noErrors: true,
		},
	},

	// ── File reading ─────────────────────────────────────────────────────────

	{
		id: "read-file",
		description: "Agent reads a file and reports its content",
		prompt: "Read package.json and tell me the project name.",
		expect: {
			toolsCalled: ["read"],
			containsAny: ["cast"],
			noErrors: true,
			verify: ({ toolCalls }) => {
				const readPackageJson = toolCalls.some(
					(tc) => tc.name === "read" && typeof tc.args.path === "string" && tc.args.path.endsWith("package.json"),
				);
				if (!readPackageJson) return "agent answered without actually calling read on package.json";
				return undefined;
			},
		},
	},

	{
		id: "read-with-offset",
		description: "Agent uses offset/limit for large files",
		prompt: "Read src/loop.ts lines 1-10 only.",
		expect: {
			toolsCalled: ["read"],
			noErrors: true,
			verify: ({ toolCalls }) => {
				const usedOffsetOrLimit = toolCalls.some(
					(tc) => tc.name === "read" && (typeof tc.args.offset === "number" || typeof tc.args.limit === "number"),
				);
				if (!usedOffsetOrLimit)
					return "agent read the file without passing offset/limit — didn't respect 'lines 1-10 only'";
				return undefined;
			},
		},
	},

	{
		id: "read-nonexistent",
		description: "Agent handles missing file gracefully",
		prompt: "Read /nonexistent/file.txt and report what happened.",
		expect: {
			toolsCalled: ["read"],
			containsAny: ["not found", "ENOENT", "does not exist", "error"],
			noErrors: true,
		},
	},

	// ── File writing / editing (grounded in real files on disk) ────────────

	{
		id: "write-file",
		description: "Agent creates a new file",
		setup: () => void writeFixture("write-file", {}),
		prompt: `Create a file called ${fixturePath("write-file", "out.txt")} with content 'hello from eval'.`,
		expect: {
			toolsCalled: ["write"],
			noErrors: true,
			verify: () => {
				const content = readFileSync(fixturePath("write-file", "out.txt"), "utf-8").trim();
				if (content !== "hello from eval") return `file content was "${content}", expected "hello from eval"`;
				return undefined;
			},
		},
	},

	{
		id: "edit-file",
		description: "Agent edits an existing file",
		setup: () => void writeFixture("edit-file", {}),
		prompt: `First write 'aaa bbb ccc' to ${fixturePath("edit-file", "out.txt")}, then edit it to replace 'bbb' with 'xxx'.`,
		expect: {
			toolsCalled: ["write", "edit"],
			noErrors: true,
			verify: () => {
				const content = readFileSync(fixturePath("edit-file", "out.txt"), "utf-8").trim();
				if (content !== "aaa xxx ccc") return `file content was "${content}", expected "aaa xxx ccc"`;
				return undefined;
			},
		},
	},

	// ── Bash execution ───────────────────────────────────────────────────────

	{
		id: "bash-simple",
		description: "Agent runs a simple bash command",
		prompt: "Run 'echo hello-world' using bash.",
		expect: {
			toolsCalled: ["bash"],
			containsAny: ["hello-world"],
			noErrors: true,
		},
	},

	{
		id: "bash-multi",
		description: "Agent runs multiple bash commands",
		prompt: "Run 'echo aaa' and 'echo bbb' as two separate bash commands.",
		expect: {
			toolCallCounts: { bash: 2 },
			containsAll: ["aaa", "bbb"],
			noErrors: true,
		},
	},

	{
		id: "bash-error-handling",
		description: "Agent handles bash command failure",
		prompt: "Run 'ls /nonexistent_directory_xyz' and report the error.",
		expect: {
			toolsCalled: ["bash"],
			containsAny: ["error", "No such file", "not found"],
			noErrors: true,
		},
	},

	// ── Search ───────────────────────────────────────────────────────────────

	{
		id: "grep-search",
		description: "Agent searches file contents with grep",
		prompt: "Search for the word 'export' in src/config.ts.",
		expect: {
			toolsCalled: ["grep"],
			containsAny: ["export"],
			noErrors: true,
			verify: ({ toolCalls }) => {
				const searchedForExport = toolCalls.some(
					(tc) => tc.name === "grep" && typeof tc.args.pattern === "string" && /export/i.test(tc.args.pattern),
				);
				if (!searchedForExport) return "agent didn't actually grep for 'export'";
				return undefined;
			},
		},
	},

	{
		id: "find-files",
		description: "Agent finds files by pattern",
		prompt: "Find all .test.ts files in the test/ directory.",
		expect: {
			toolsCalled: ["find"],
			containsAny: ["config.test.ts", "session.test.ts", "loop.test.ts", "tools.test.ts"],
			noErrors: true,
			verify: ({ toolCalls }) => {
				const searchedTestTs = toolCalls.some(
					(tc) => tc.name === "find" && typeof tc.args.pattern === "string" && /test\.ts/i.test(tc.args.pattern),
				);
				if (!searchedTestTs) return "agent didn't search with a *.test.ts pattern";
				return undefined;
			},
		},
	},

	{
		id: "ls-directory",
		description: "Agent lists directory contents",
		prompt: "List the contents of the src/ directory.",
		expect: {
			toolsCalled: ["ls"],
			containsAny: ["config.ts", "loop.ts", "tools.ts"],
			noErrors: true,
			verify: ({ toolCalls }) => {
				const listedSrc = toolCalls.some(
					(tc) => tc.name === "ls" && typeof tc.args.path === "string" && tc.args.path.includes("src"),
				);
				if (!listedSrc) return "agent didn't call ls with a path pointing at src/";
				return undefined;
			},
		},
	},

	// ── Multi-step (grounded ground truth, not keyword guessing) ───────────

	{
		id: "read-then-analyze",
		description: "Agent reads a file and reports an exact count, checked against real ground truth",
		prompt: "Read src/tools.ts and tell me exactly how many exported functions it has. Answer with just the number.",
		expect: {
			toolsCalled: ["read"],
			maxTurns: 3,
			noErrors: true,
			verify: ({ response, cwd }) => {
				const source = readFileSync(join(cwd, "src/tools.ts"), "utf-8");
				const expected = (source.match(/^export (async )?function/gm) ?? []).length;
				const mentioned = (response.match(/\d+/g) ?? []).map(Number);
				if (!mentioned.includes(expected)) {
					return `expected count ${expected} not found in response (mentioned numbers: ${mentioned.join(", ") || "none"})`;
				}
				return undefined;
			},
		},
	},

	{
		id: "find-then-grep",
		description: "Agent combines find and grep to locate real matches",
		prompt: "Find all .ts files in src/ and search for 'export function' in them. List which files matched.",
		expect: {
			toolsCalled: ["find", "grep"],
			maxTurns: 4,
			noErrors: true,
			verify: ({ response, cwd }) => {
				const out = execSync(`grep -rl "export function" src`, { cwd, encoding: "utf-8" });
				const expectedFiles = out
					.trim()
					.split("\n")
					.map((p) => p.split("/").pop()!);
				const missing = expectedFiles.filter((f) => !response.includes(f));
				if (missing.length > 0) return `response is missing real matching file(s): ${missing.join(", ")}`;
				return undefined;
			},
		},
	},

	{
		id: "write-then-read-back",
		description: "Agent writes a file and reads it back to verify",
		setup: () => void writeFixture("write-then-read-back", {}),
		prompt: `Write 'eval-test-content-12345' to ${fixturePath("write-then-read-back", "verify.txt")}, then read the file back and confirm the content.`,
		expect: {
			toolsCalled: ["write", "read"],
			containsAny: ["eval-test-content-12345"],
			noErrors: true,
			verify: () => {
				const content = readFileSync(fixturePath("write-then-read-back", "verify.txt"), "utf-8").trim();
				if (content !== "eval-test-content-12345")
					return `file on disk contains "${content}", not the expected content`;
				return undefined;
			},
		},
	},

	{
		id: "error-recovery",
		description: "Agent recovers from a tool error and tries an alternative",
		prompt: "Try to read /nonexistent/path, then read package.json instead.",
		expect: {
			toolsCalled: ["read"],
			containsAny: ["cast", "package"],
			maxTurns: 4,
			noErrors: true,
			verify: ({ toolCalls }) => {
				const badIdx = toolCalls.findIndex(
					(tc) => tc.name === "read" && typeof tc.args.path === "string" && tc.args.path.includes("/nonexistent/"),
				);
				const goodIdx = toolCalls.findIndex(
					(tc) => tc.name === "read" && typeof tc.args.path === "string" && tc.args.path.endsWith("package.json"),
				);
				if (badIdx === -1) return "agent never actually attempted the nonexistent path";
				if (goodIdx === -1) return "agent never actually read package.json";
				if (goodIdx < badIdx) return "agent read package.json before attempting the nonexistent path";
				return undefined;
			},
		},
	},

	// ── Complex multi-step (execution-grounded) ─────────────────────────────

	{
		id: "rename-function-multi-file",
		description: "Agent renames a function across two files without breaking the code",
		setup: () =>
			void writeFixture("rename-function-multi-file", {
				"mathUtils.js": `function calculateTotal(items) {\n\treturn items.reduce((a, b) => a + b, 0);\n}\n\nmodule.exports = { calculateTotal };\n`,
				"report.js": `const { calculateTotal } = require("./mathUtils.js");\n\nconsole.log("Total:", calculateTotal([10, 20, 30]));\n`,
			}),
		prompt:
			`In ${fixtureDir("rename-function-multi-file")}/ there are two files: mathUtils.js and report.js. ` +
			"Rename the function `calculateTotal` to `computeSum` everywhere it is defined, exported, or called " +
			"across both files. Do not change any other logic.",
		expect: {
			toolsCalled: ["read", "edit"],
			maxTurns: 8,
			noErrors: true,
			verify: () => {
				const dir = fixtureDir("rename-function-multi-file");
				const mathUtils = readFileSync(join(dir, "mathUtils.js"), "utf-8");
				const report = readFileSync(join(dir, "report.js"), "utf-8");
				if (mathUtils.includes("calculateTotal") || report.includes("calculateTotal")) {
					return "old name 'calculateTotal' still present after rename";
				}
				if (!mathUtils.includes("computeSum") || !report.includes("computeSum")) {
					return "new name 'computeSum' missing from one of the files";
				}
				try {
					const out = execSync("node report.js", { cwd: dir, encoding: "utf-8", timeout: 5000 }).trim();
					if (out !== "Total: 60") return `report.js produced unexpected output after rename: "${out}"`;
				} catch (error) {
					return `report.js failed to run after rename: ${error instanceof Error ? error.message : String(error)}`;
				}
				return undefined;
			},
		},
	},

	{
		id: "fix-bug-execution-grounded",
		description: "Agent finds and fixes a real bug, verified by actually re-running the test",
		setup: () =>
			void writeFixture("fix-bug-execution-grounded", {
				"calc.js":
					"function average(nums) {\n\tlet sum = 0;\n\tfor (let i = 0; i < nums.length; i++) sum += nums[i];\n" +
					"\treturn sum / (nums.length - 1);\n}\n\nmodule.exports = { average };\n",
				"test.js":
					'const { average } = require("./calc.js");\n\nconst result = average([1, 2, 3, 4, 5]);\n' +
					'if (result !== 3) {\n\tconsole.log("FAIL: expected 3, got " + result);\n\tprocess.exit(1);\n}\n' +
					'console.log("PASS");\nprocess.exit(0);\n',
			}),
		prompt:
			`In ${fixtureDir("fix-bug-execution-grounded")}/ there's calc.js and test.js. Run 'node test.js' with bash — ` +
			"it currently fails. Read calc.js, find the bug, fix it with the edit tool, then re-run 'node test.js' to confirm it passes.",
		expect: {
			toolCallCounts: { bash: 2, edit: 1 },
			maxTurns: 8,
			noErrors: true,
			verify: () => {
				const dir = fixtureDir("fix-bug-execution-grounded");
				try {
					const out = execSync("node test.js", { cwd: dir, encoding: "utf-8", timeout: 5000 }).trim();
					if (out !== "PASS") return `test.js did not print PASS after the fix, got: "${out}"`;
				} catch (error) {
					return `test.js still fails after agent's fix: ${error instanceof Error ? error.message : String(error)}`;
				}
				return undefined;
			},
		},
	},

	{
		id: "find-fix-typo-across-files",
		description: "Agent locates a misspelled constant across files and fixes every occurrence",
		setup: () =>
			void writeFixture("find-fix-typo-across-files", {
				"constants.js": "const MAX_RETIRES = 3;\n\nmodule.exports = { MAX_RETIRES };\n",
				"client.js":
					'const { MAX_RETIRES } = require("./constants.js");\n\nconsole.log("Max retries allowed:", MAX_RETIRES);\n',
			}),
		prompt:
			`Somewhere under ${fixtureDir("find-fix-typo-across-files")}/ a constant is misspelled: it appears as ` +
			"MAX_RETIRES but should be MAX_RETRIES. Find every file that references it and fix the spelling everywhere " +
			"(both the definition and all usages), without changing anything else.",
		expect: {
			maxTurns: 8,
			noErrors: true,
			verify: () => {
				const dir = fixtureDir("find-fix-typo-across-files");
				const constants = readFileSync(join(dir, "constants.js"), "utf-8");
				const client = readFileSync(join(dir, "client.js"), "utf-8");
				if (constants.includes("MAX_RETIRES") || client.includes("MAX_RETIRES")) {
					return "misspelling 'MAX_RETIRES' still present somewhere";
				}
				if (!constants.includes("MAX_RETRIES") || !client.includes("MAX_RETRIES")) {
					return "corrected 'MAX_RETRIES' missing from one of the files";
				}
				try {
					const out = execSync("node client.js", { cwd: dir, encoding: "utf-8", timeout: 5000 }).trim();
					if (out !== "Max retries allowed: 3") return `client.js produced unexpected output after fix: "${out}"`;
				} catch (error) {
					return `client.js failed to run after fix: ${error instanceof Error ? error.message : String(error)}`;
				}
				return undefined;
			},
		},
	},
];
