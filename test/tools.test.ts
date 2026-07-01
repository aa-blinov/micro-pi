import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { createToolExecutor } from "../src/core/tools.ts";

const TEST_DIR = join(import.meta.dirname, "__test_tmp__");

const mockConfig: AppConfig = {
	baseURL: "http://localhost",
	apiKey: "test",
	contextWindow: 128_000,
	maxResponseTokens: 8192,
	compactionThreshold: 0.75,
	maxToolOutputLines: 2000,
	maxToolOutputBytes: 64 * 1024,
	defaultBashTimeout: 10,
};

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

// ============================================================================
// bash
// ============================================================================

describe("bash", () => {
	it("executes a command and returns output", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("bash", { command: "echo hello" });
		expect(result.content.trim()).toBe("hello");
		expect(result.isError).toBeFalsy();
	});

	it("returns stderr on failure", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("bash", { command: "ls /nonexistent_path_12345" });
		expect(result.isError).toBe(true);
	});

	it("respects timeout", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("bash", { command: "sleep 10", timeout: 1 });
		// Process is killed — either isError or output contains timeout info
		expect(
			result.isError === true || result.content.includes("timeout") || result.content.includes("exit code"),
		).toBe(true);
	});

	it("kills an in-flight command as soon as the AbortSignal fires, not just the next request", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const controller = new AbortController();

		const start = Date.now();
		const resultPromise = exec("bash", { command: "sleep 30", timeout: 60 }, controller.signal);
		// Give the process a moment to actually start, then abort — this is
		// the exact "long command already running" case /abort is for.
		await new Promise((r) => setTimeout(r, 200));
		controller.abort();

		const result = await resultPromise;
		const elapsed = Date.now() - start;

		expect(result.isError).toBe(true);
		expect(result.content).toContain("aborted");
		// Killed promptly, nowhere near the 30s sleep or 60s timeout it would
		// otherwise have run for.
		expect(elapsed).toBeLessThan(5000);
	});

	it("returns immediately without spawning if already aborted before the call", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const controller = new AbortController();
		controller.abort();

		const start = Date.now();
		const result = await exec("bash", { command: "sleep 30" }, controller.signal);
		const elapsed = Date.now() - start;

		expect(result.isError).toBe(true);
		expect(elapsed).toBeLessThan(1000);
	});

	it("does not call confirmBash for ordinary commands", async () => {
		const confirmBash = vi.fn(async () => true);
		const exec = createToolExecutor(TEST_DIR, mockConfig, confirmBash);
		await exec("bash", { command: "echo hello" });
		expect(confirmBash).not.toHaveBeenCalled();
	});

	it("asks confirmBash before a dangerous command, and runs it if allowed", async () => {
		const confirmBash = vi.fn(async () => true);
		const exec = createToolExecutor(TEST_DIR, mockConfig, confirmBash);
		// `-n` (non-interactive) makes sudo fail fast with "a password is
		// required" instead of prompting — deterministic everywhere, unlike a
		// bare `sudo echo x`, which relies on there being no controlling TTY
		// (true here, but not guaranteed on a machine with an askpass helper
		// or NOPASSWD sudoers entry) to avoid hanging on a password prompt.
		const result = await exec("bash", { command: "echo would-be-dangerous && sudo -n true" });
		expect(confirmBash).toHaveBeenCalledTimes(1);
		expect(confirmBash.mock.calls[0]?.[1]).toContain("sudo");
		expect(result.content).toContain("would-be-dangerous");
	});

	it("blocks a dangerous command without executing it if confirmBash denies", async () => {
		const confirmBash = vi.fn(async () => false);
		const exec = createToolExecutor(TEST_DIR, mockConfig, confirmBash);
		const result = await exec("bash", { command: "sudo rm -rf /tmp/should-not-run" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Blocked");
	});
});

// ============================================================================
// read
// ============================================================================

describe("read", () => {
	it("reads a file with line numbers", async () => {
		writeFileSync(join(TEST_DIR, "test.txt"), "line1\nline2\nline3\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("read", { path: "test.txt" });
		expect(result.content).toContain("1→line1");
		expect(result.content).toContain("2→line2");
		expect(result.content).toContain("3→line3");
	});

	it("supports offset and limit", async () => {
		writeFileSync(join(TEST_DIR, "test.txt"), "a\nb\nc\nd\ne\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("read", { path: "test.txt", offset: 2, limit: 2 });
		expect(result.content).toContain("2→b");
		expect(result.content).toContain("3→c");
		expect(result.content).not.toContain("4→d");
	});

	it("errors on missing file", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("read", { path: "nonexistent.txt" });
		expect(result.isError).toBe(true);
	});

	it("uses a non-tab separator so a tab-indented line's leading tabs stay unambiguous", async () => {
		// Regression test: a tab separator here would put a gutter tab directly
		// ahead of the file's own leading tabs with nothing to tell them apart —
		// e.g. "2" + "\t" + "\t\tconst x" reads back as an indistinguishable run
		// of 3 tabs, so a model reconstructing oldText for `edit` from this
		// output can't tell how many of those tabs are real indentation.
		writeFileSync(join(TEST_DIR, "tabs.txt"), "if (x) {\n\t\tconst y = 1;\n}\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("read", { path: "tabs.txt" });
		expect(result.content).toContain("2→\t\tconst y = 1;");
		expect(result.content).not.toContain("\t\t\tconst y = 1;");
	});
});

// ============================================================================
// write
// ============================================================================

describe("write", () => {
	it("creates a file", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("write", { path: "new.txt", content: "hello world" });
		expect(result.isError).toBeFalsy();

		const readResult = await exec("read", { path: "new.txt" });
		expect(readResult.content).toContain("hello world");
	});

	it("creates parent directories", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		await exec("write", { path: "deep/nested/file.txt", content: "ok" });
		const readResult = await exec("read", { path: "deep/nested/file.txt" });
		expect(readResult.content).toContain("ok");
	});

	it("overwrites existing file", async () => {
		writeFileSync(join(TEST_DIR, "existing.txt"), "old");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		await exec("write", { path: "existing.txt", content: "new" });
		const readResult = await exec("read", { path: "existing.txt" });
		expect(readResult.content).toContain("new");
		expect(readResult.content).not.toContain("old");
	});
});

// ============================================================================
// edit
// ============================================================================

describe("edit", () => {
	it("replaces text in a file", async () => {
		writeFileSync(join(TEST_DIR, "edit.txt"), "hello world\nfoo bar\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", {
			path: "edit.txt",
			edits: [{ oldText: "hello world", newText: "goodbye world" }],
		});
		expect(result.isError).toBeFalsy();

		const readResult = await exec("read", { path: "edit.txt" });
		expect(readResult.content).toContain("goodbye world");
	});

	it("applies multiple edits", async () => {
		writeFileSync(join(TEST_DIR, "multi.txt"), "aaa bbb ccc\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		await exec("edit", {
			path: "multi.txt",
			edits: [
				{ oldText: "aaa", newText: "111" },
				{ oldText: "ccc", newText: "333" },
			],
		});
		const readResult = await exec("read", { path: "multi.txt" });
		expect(readResult.content).toContain("111");
		expect(readResult.content).toContain("333");
	});

	it("errors on non-unique oldText", async () => {
		writeFileSync(join(TEST_DIR, "dup.txt"), "same same same\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", {
			path: "dup.txt",
			edits: [{ oldText: "same", newText: "different" }],
		});
		expect(result.isError).toBe(true);
	});

	it("errors when oldText not found", async () => {
		writeFileSync(join(TEST_DIR, "nope.txt"), "hello\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", {
			path: "nope.txt",
			edits: [{ oldText: "nonexistent", newText: "x" }],
		});
		expect(result.isError).toBe(true);
	});

	it("matches uniqueness against the original file, not edits applied so far", async () => {
		// A replacement can introduce a *new* occurrence of a later edit's
		// oldText that wasn't there originally — sequential matching against
		// the progressively-edited string used to make that later edit
		// spuriously fail as "not unique", even though oldText was unique in
		// the file the model actually read.
		writeFileSync(join(TEST_DIR, "chain.txt"), "aaa\nccc\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", {
			path: "chain.txt",
			edits: [
				{ oldText: "aaa", newText: "ccc" }, // introduces a 2nd "ccc"
				{ oldText: "ccc", newText: "ddd" }, // unique in the original
			],
		});
		expect(result.isError).toBeFalsy();
		expect(readFileSync(join(TEST_DIR, "chain.txt"), "utf-8")).toBe("ccc\nddd\n");
	});

	it("rejects two edits whose oldText overlaps in the original file", async () => {
		writeFileSync(join(TEST_DIR, "overlap.txt"), "hello world\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", {
			path: "overlap.txt",
			edits: [
				{ oldText: "hello world", newText: "a" },
				{ oldText: "world", newText: "b" },
			],
		});
		expect(result.isError).toBe(true);
		expect(result.content.toLowerCase()).toContain("overlap");

		// The file must be untouched — an overlap is rejected atomically,
		// not partially applied.
		const readResult = await exec("read", { path: "overlap.txt" });
		expect(readResult.content).toContain("hello world");
	});
});

// ============================================================================
// find
// ============================================================================

describe("find", () => {
	it("finds files by pattern", async () => {
		writeFileSync(join(TEST_DIR, "a.ts"), "");
		writeFileSync(join(TEST_DIR, "b.ts"), "");
		writeFileSync(join(TEST_DIR, "c.js"), "");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("find", { pattern: "*.ts", path: TEST_DIR });
		expect(result.content).toContain("a.ts");
		expect(result.content).toContain("b.ts");
		expect(result.content).not.toContain("c.js");
	});

	it("does not let a pattern break out and run injected shell commands", async () => {
		// pattern comes straight from a tool call argument — a single quote
		// used to break out of the execSync(`fd ... '${pattern}' ...`) string
		// and let the rest execute as a real shell command (confirmed
		// exploitable before this used execFileSync with an argument array).
		const canary = join(TEST_DIR, "injected.txt");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		await exec("find", {
			pattern: `x'; touch '${canary}`,
			path: TEST_DIR,
		});
		expect(existsSync(canary)).toBe(false);
	});
});

// ============================================================================
// grep
// ============================================================================

describe("grep", () => {
	it("finds matching lines", async () => {
		writeFileSync(join(TEST_DIR, "grep.txt"), "hello world\nfoo bar\nhello again\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("grep", { pattern: "hello", path: TEST_DIR });
		expect(result.content).toContain("hello world");
		expect(result.content).toContain("hello again");
		expect(result.content).not.toContain("foo bar");
	});

	it("does not let a pattern break out and run injected shell commands", async () => {
		const canary = join(TEST_DIR, "injected.txt");
		writeFileSync(join(TEST_DIR, "grep.txt"), "hello world\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		await exec("grep", {
			pattern: `x'; touch '${canary}`,
			path: TEST_DIR,
		});
		expect(existsSync(canary)).toBe(false);
	});

	it("does not let glob break out and run injected shell commands", async () => {
		const canary = join(TEST_DIR, "injected.txt");
		writeFileSync(join(TEST_DIR, "grep.txt"), "hello world\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		await exec("grep", {
			pattern: "hello",
			path: TEST_DIR,
			glob: `*'; touch '${canary}`,
		});
		expect(existsSync(canary)).toBe(false);
	});
});

// ============================================================================
// ls
// ============================================================================

describe("ls", () => {
	it("lists directory contents", async () => {
		writeFileSync(join(TEST_DIR, "file1.txt"), "");
		writeFileSync(join(TEST_DIR, "file2.txt"), "");
		mkdirSync(join(TEST_DIR, "subdir"));
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("ls", { path: TEST_DIR });
		expect(result.content).toContain("file1.txt");
		expect(result.content).toContain("file2.txt");
		expect(result.content).toContain("subdir/");
	});
});

// ============================================================================
// unknown tool
// ============================================================================

describe("unknown tool", () => {
	it("returns error for unknown tool", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("nonexistent", {});
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Unknown tool");
	});
});
