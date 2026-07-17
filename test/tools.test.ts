import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { PLAN_TOOL_NAMES, type PlanState } from "../src/core/plan.ts";
import { isPermissionError, withAccessNote } from "../src/core/tools/search.ts";
import { createToolExecutor, getToolDefinitions } from "../src/core/tools.ts";

const TEST_DIR = join(import.meta.dirname, "__test_tmp__", "tools");

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
	rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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

	// Live-echo gating: only a command that looks like it's waiting for input
	// (still running past the grace + non-newline-terminated output) is shown
	// live; fast and long-but-line-buffered commands stay silent (captured only),
	// so their output isn't duplicated on screen.
	function captureStderr() {
		const writes: string[] = [];
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
			return true;
		}) as typeof process.stderr.write);
		return { writes, restore: () => spy.mockRestore() };
	}

	it("does not echo a fast command live — captured only, no duplication", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const { writes, restore } = captureStderr();
		try {
			const result = await exec("bash", { command: "echo fast-marker-1" });
			expect(result.content.trim()).toBe("fast-marker-1");
			expect(writes.join("")).not.toContain("fast-marker-1");
		} finally {
			restore();
		}
	});

	it("does not echo a slow but newline-terminated (non-interactive) command live", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const { writes, restore } = captureStderr();
		try {
			// Line-buffered output while still running past the grace — like a long
			// test streaming logs. Must NOT be revealed live.
			const result = await exec("bash", { command: "echo slow-line-marker; sleep 0.5" });
			expect(result.content).toContain("slow-line-marker");
			expect(writes.join("")).not.toContain("slow-line-marker");
		} finally {
			restore();
		}
	});

	it("blocks interactive read -p command", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("bash", { command: "read -p 'Name: ' name && echo Hello_$name" });
		expect(result.isError).toBe(true);
		// stdin is /dev/null — read gets EOF and the command fails
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
		expect(result.content).toContain("[ABORTED]");
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
	it("reads a file with hashline anchors", async () => {
		writeFileSync(join(TEST_DIR, "test.txt"), "line1\nline2\nline3\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("read", { path: "test.txt" });
		// Each line is prefixed with `<LINE>:<LOCAL>:<CHUNK>→content`.
		expect(result.content).toMatch(/\b1:[a-z]{3}:[a-z]{3}→line1\b/);
		expect(result.content).toMatch(/\b2:[a-z]{3}:[a-z]{3}→line2\b/);
		expect(result.content).toMatch(/\b3:[a-z]{3}:[a-z]{3}→line3\b/);
	});

	it("supports offset and limit", async () => {
		writeFileSync(join(TEST_DIR, "test.txt"), "a\nb\nc\nd\ne\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("read", { path: "test.txt", offset: 2, limit: 2 });
		expect(result.content).toMatch(/\b2:[a-z]{3}:[a-z]{3}→b\b/);
		expect(result.content).toMatch(/\b3:[a-z]{3}:[a-z]{3}→c\b/);
		expect(result.content).not.toMatch(/\b4:[a-z]{3}:[a-z]{3}→d/);
	});

	it("errors on missing file", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("read", { path: "nonexistent.txt" });
		expect(result.isError).toBe(true);
	});

	it("uses a non-tab separator so a tab-indented line's leading tabs stay unambiguous", async () => {
		// Regression test: a tab separator here would put a gutter tab directly
		// ahead of the file's own leading tabs with nothing to tell them apart —
		// so a model reconstructing line content from this output can't tell
		// how many of those tabs are real indentation. The hashline gutter
		// already includes a `→` (U+2192) separator that can never appear as
		// leading whitespace in source, so the same trick still works.
		writeFileSync(join(TEST_DIR, "tabs.txt"), "if (x) {\n\t\tconst y = 1;\n}\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("read", { path: "tabs.txt" });
		expect(result.content).toMatch(/\b2:[a-z]{3}:[a-z]{3}→\t\tconst y = 1;/);
		expect(result.content).not.toContain("\t\t\tconst y = 1;");
	});

	it("rejects empty path", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("read", { path: "" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("path");
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

	it("rejects empty path", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("write", { path: "", content: "data" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("path");
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

/**
 * Pull the hashline anchor for a given 1-based line number out of a
 * previous `read` call's output. Test-only helper — the production path
 * never re-parses the read result; the model just echoes the anchor it
 * saw. We only do this here so the tests don't have to embed hand-
 * computed hashes.
 */
function anchorForLine(readContent: string, line: number): string {
	const re = new RegExp(`(?:^|\\n)${line}:([a-z]{3}:[a-z]{3})\\u2192`);
	const match = re.exec(readContent);
	if (!match) throw new Error(`No anchor for line ${line} in read output:\n${readContent}`);
	return `${line}:${match[1]}`;
}

describe("edit", () => {
	it("replaces a single line by anchor", async () => {
		writeFileSync(join(TEST_DIR, "edit.txt"), "hello world\nfoo bar\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const before = await exec("read", { path: "edit.txt" });
		const result = await exec("edit", {
			path: "edit.txt",
			ops: [{ op: "replace", anchor: anchorForLine(before.content, 1), content: "goodbye world" }],
		});
		expect(result.isError).toBeFalsy();
		const after = readFileSync(join(TEST_DIR, "edit.txt"), "utf-8");
		expect(after).toBe("goodbye world\nfoo bar\n");
	});

	it("replaces a line range using anchor + end_anchor", async () => {
		writeFileSync(join(TEST_DIR, "range.txt"), "alpha\nbeta\ngamma\ndelta\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const before = await exec("read", { path: "range.txt" });
		const result = await exec("edit", {
			path: "range.txt",
			ops: [
				{
					op: "replace",
					anchor: anchorForLine(before.content, 2),
					end_anchor: anchorForLine(before.content, 3),
					content: "BETA-GAMMA",
				},
			],
		});
		expect(result.isError).toBeFalsy();
		const after = readFileSync(join(TEST_DIR, "range.txt"), "utf-8");
		expect(after).toBe("alpha\nBETA-GAMMA\ndelta\n");
	});

	it("inserts new lines after an anchor", async () => {
		writeFileSync(join(TEST_DIR, "insert.txt"), "first\nthird\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const before = await exec("read", { path: "insert.txt" });
		const result = await exec("edit", {
			path: "insert.txt",
			ops: [
				{
					op: "insert_after",
					anchor: anchorForLine(before.content, 1),
					content: "second",
				},
			],
		});
		expect(result.isError).toBeFalsy();
		const after = readFileSync(join(TEST_DIR, "insert.txt"), "utf-8");
		expect(after).toBe("first\nsecond\nthird\n");
	});

	it("replaces the whole file via a write op", async () => {
		writeFileSync(join(TEST_DIR, "write.txt"), "old content\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", {
			path: "write.txt",
			ops: [{ op: "write", content: "entirely new\ncontent here\n" }],
		});
		expect(result.isError).toBeFalsy();
		expect(readFileSync(join(TEST_DIR, "write.txt"), "utf-8")).toBe("entirely new\ncontent here\n");
	});

	it("reports stale anchors with a fresh-anchor snippet instead of a bare miss", async () => {
		// Simulate a stale read: read the file, then mutate it externally,
		// then try to edit using the anchor from the pre-mutation read. The
		// tool must reject the op and return fresh anchors the model can
		// paste back in — no manual re-read required.
		writeFileSync(join(TEST_DIR, "drift.txt"), "alpha\nbeta\ngamma\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const before = await exec("read", { path: "drift.txt" });
		const stale = anchorForLine(before.content, 2);
		writeFileSync(join(TEST_DIR, "drift.txt"), "alpha\nBETA\ngamma\n");

		const result = await exec("edit", {
			path: "drift.txt",
			ops: [{ op: "replace", anchor: stale, content: "replacement" }],
		});
		expect(result.isError).toBe(true);
		expect(result.content).toContain("stale");
		// Fresh anchors for the post-mutation file must be in the error
		// message so the model can retry without re-`read`ing.
		expect(result.content).toMatch(/\b2:[a-z]{3}:[a-z]{3}→BETA\b/);
		// File must not be partially mutated by the rejected op.
		expect(readFileSync(join(TEST_DIR, "drift.txt"), "utf-8")).toBe("alpha\nBETA\ngamma\n");
	});

	it("rejects an anchor past the end of the file", async () => {
		writeFileSync(join(TEST_DIR, "short.txt"), "only line\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", {
			path: "short.txt",
			ops: [{ op: "replace", anchor: "99:deadbe", content: "x" }],
		});
		expect(result.isError).toBe(true);
		expect(result.content).toMatch(/past the end/i);
	});

	it("auto-recovers an anchor whose line merely moved, noting it in the reply", async () => {
		// Read, then insert a line above externally: the anchored line's
		// content is intact but lives one line lower. The edit must apply
		// at the new position in one call, with a note saying so.
		writeFileSync(join(TEST_DIR, "shifted.txt"), "one\ntwo\nthree\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const before = await exec("read", { path: "shifted.txt" });
		const oldAnchor = anchorForLine(before.content, 2); // "two"
		writeFileSync(join(TEST_DIR, "shifted.txt"), "inserted\none\ntwo\nthree\n");

		const result = await exec("edit", {
			path: "shifted.txt",
			ops: [{ op: "replace", anchor: oldAnchor, content: "TWO" }],
		});
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("shifted from line 2 to line 3");
		expect(readFileSync(join(TEST_DIR, "shifted.txt"), "utf-8")).toBe("inserted\none\nTWO\nthree\n");
	});

	it("auto-recovers an anchor whose chunk drifted but line is intact", async () => {
		writeFileSync(join(TEST_DIR, "drifted.txt"), "a\nb\nc\nd\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const before = await exec("read", { path: "drifted.txt" });
		const target = anchorForLine(before.content, 3); // "c"
		// External edit to a neighbour in the same chunk; "c" untouched.
		writeFileSync(join(TEST_DIR, "drifted.txt"), "a\nB\nc\nd\n");

		const result = await exec("edit", {
			path: "drifted.txt",
			ops: [{ op: "replace", anchor: target, content: "C" }],
		});
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("nearby lines changed");
		expect(readFileSync(join(TEST_DIR, "drifted.txt"), "utf-8")).toBe("a\nB\nC\nd\n");
	});

	it("still rejects a stale anchor when the content is genuinely gone", async () => {
		writeFileSync(join(TEST_DIR, "gone.txt"), "a\nb\nc\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const before = await exec("read", { path: "gone.txt" });
		const target = anchorForLine(before.content, 2); // "b"
		writeFileSync(join(TEST_DIR, "gone.txt"), "a\nREWRITTEN\nc\n");

		const result = await exec("edit", {
			path: "gone.txt",
			ops: [{ op: "replace", anchor: target, content: "B" }],
		});
		expect(result.isError).toBe(true);
		expect(result.content).toContain("stale");
		expect(readFileSync(join(TEST_DIR, "gone.txt"), "utf-8")).toBe("a\nREWRITTEN\nc\n");
	});

	it("still rejects a stale anchor when several nearby lines match it", async () => {
		writeFileSync(join(TEST_DIR, "ambig.txt"), "x\ndup\ny\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const before = await exec("read", { path: "ambig.txt" });
		const target = anchorForLine(before.content, 2); // "dup"
		// External edit replaces the original and adds two copies nearby —
		// the anchor's content now matches multiple lines.
		writeFileSync(join(TEST_DIR, "ambig.txt"), "dup\nx\nchanged\ny\ndup\n");

		const result = await exec("edit", {
			path: "ambig.txt",
			ops: [{ op: "replace", anchor: target, content: "DUP" }],
		});
		expect(result.isError).toBe(true);
		expect(result.content).toContain("multiple nearby lines match");
		expect(readFileSync(join(TEST_DIR, "ambig.txt"), "utf-8")).toBe("dup\nx\nchanged\ny\ndup\n");
	});

	it("echoes the edited region with fresh anchors on success", async () => {
		writeFileSync(join(TEST_DIR, "echo.txt"), "l1\nl2\nl3\nl4\nl5\nl6\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const before = await exec("read", { path: "echo.txt" });
		const result = await exec("edit", {
			path: "echo.txt",
			ops: [{ op: "replace", anchor: anchorForLine(before.content, 3), content: "L3a\nL3b" }],
		});
		expect(result.isError).toBeFalsy();
		// The success reply must show the new content in place, with valid
		// anchors around it, so the model can verify and chain edits.
		expect(result.content).toMatch(/\b3:[a-z]{3}:[a-z]{3}→L3a\b/);
		expect(result.content).toMatch(/\b4:[a-z]{3}:[a-z]{3}→L3b\b/);
		expect(result.content).toMatch(/\b2:[a-z]{3}:[a-z]{3}→l2\b/); // context above
		expect(result.content).toMatch(/\b6:[a-z]{3}:[a-z]{3}→l5\b/); // context below, shifted by +1
		// A follow-up edit must be able to use an anchor from the snippet.
		const suggested = /(\d+:[a-z]{3}:[a-z]{3})→L3b/.exec(result.content);
		const chained = await exec("edit", {
			path: "echo.txt",
			ops: [{ op: "replace", anchor: suggested![1]!, content: "L3B" }],
		});
		expect(chained.isError).toBeFalsy();
		expect(readFileSync(join(TEST_DIR, "echo.txt"), "utf-8")).toBe("l1\nl2\nL3a\nL3B\nl4\nl5\nl6\n");
	});

	it("insert_before puts lines above the anchored line", async () => {
		// The exact changelog case: a new section goes ABOVE an existing
		// heading, anchored on the heading itself.
		writeFileSync(join(TEST_DIR, "before.txt"), "# Changelog\n\n## 0.6.7\n\n- old entry\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const before = await exec("read", { path: "before.txt" });
		const result = await exec("edit", {
			path: "before.txt",
			ops: [{ op: "insert_before", anchor: anchorForLine(before.content, 3), content: "## 0.6.8\n\n- new entry\n" }],
		});
		expect(result.isError).toBeFalsy();
		expect(readFileSync(join(TEST_DIR, "before.txt"), "utf-8")).toBe(
			"# Changelog\n\n## 0.6.8\n\n- new entry\n\n## 0.6.7\n\n- old entry\n",
		);
	});

	it("insert_before the first line prepends to the file", async () => {
		writeFileSync(join(TEST_DIR, "before-top.txt"), "first\nsecond\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const before = await exec("read", { path: "before-top.txt" });
		const result = await exec("edit", {
			path: "before-top.txt",
			ops: [{ op: "insert_before", anchor: anchorForLine(before.content, 1), content: "header" }],
		});
		expect(result.isError).toBeFalsy();
		expect(readFileSync(join(TEST_DIR, "before-top.txt"), "utf-8")).toBe("header\nfirst\nsecond\n");
	});

	it("rejects an insert_before anchored strictly inside a replace range", async () => {
		writeFileSync(join(TEST_DIR, "before-overlap.txt"), "l1\nl2\nl3\nl4\nl5\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const before = await exec("read", { path: "before-overlap.txt" });
		const result = await exec("edit", {
			path: "before-overlap.txt",
			ops: [
				{ op: "insert_before", anchor: anchorForLine(before.content, 3), content: "X" },
				{
					op: "replace",
					anchor: anchorForLine(before.content, 2),
					end_anchor: anchorForLine(before.content, 4),
					content: "R",
				},
			],
		});
		expect(result.isError).toBe(true);
		expect(result.content.toLowerCase()).toContain("overlap");
		expect(readFileSync(join(TEST_DIR, "before-overlap.txt"), "utf-8")).toBe("l1\nl2\nl3\nl4\nl5\n");
	});

	it('inserts at the top of the file with the "0:" anchor', async () => {
		writeFileSync(join(TEST_DIR, "top.txt"), "first\nsecond\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		await exec("read", { path: "top.txt" });
		const result = await exec("edit", {
			path: "top.txt",
			ops: [{ op: "insert_after", anchor: "0:", content: "header" }],
		});
		expect(result.isError).toBeFalsy();
		expect(readFileSync(join(TEST_DIR, "top.txt"), "utf-8")).toBe("header\nfirst\nsecond\n");
	});

	it("rejects the whole batch when one anchor is stale", async () => {
		// Two ops in one call. The first is valid; the second uses an
		// anchor from a previous read of a now-different file. The valid
		// op must not be silently applied.
		writeFileSync(join(TEST_DIR, "batch.txt"), "alpha\nbeta\ngamma\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const before = await exec("read", { path: "batch.txt" });
		const validAnchor = anchorForLine(before.content, 1);
		const staleAnchor = anchorForLine(before.content, 2);
		writeFileSync(join(TEST_DIR, "batch.txt"), "alpha\nBETA\ngamma\n");

		const result = await exec("edit", {
			path: "batch.txt",
			ops: [
				{ op: "replace", anchor: validAnchor, content: "ALPHA" },
				{ op: "replace", anchor: staleAnchor, content: "REPLACED" },
			],
		});
		expect(result.isError).toBe(true);
		expect(result.content).toContain("stale");
		// Atomic rejection: line 1 must still be the original.
		expect(readFileSync(join(TEST_DIR, "batch.txt"), "utf-8")).toBe("alpha\nBETA\ngamma\n");
	});

	it("rejects two overlapping replace ranges", async () => {
		writeFileSync(join(TEST_DIR, "overlap.txt"), "a\nb\nc\nd\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const before = await exec("read", { path: "overlap.txt" });
		const result = await exec("edit", {
			path: "overlap.txt",
			ops: [
				{
					op: "replace",
					anchor: anchorForLine(before.content, 1),
					end_anchor: anchorForLine(before.content, 3),
					content: "X",
				},
				{
					op: "replace",
					anchor: anchorForLine(before.content, 3),
					end_anchor: anchorForLine(before.content, 4),
					content: "Y",
				},
			],
		});
		expect(result.isError).toBe(true);
		expect(result.content.toLowerCase()).toContain("overlap");
		expect(readFileSync(join(TEST_DIR, "overlap.txt"), "utf-8")).toBe("a\nb\nc\nd\n");
	});

	it("rejects an insert_after anchored inside a replace range", async () => {
		writeFileSync(join(TEST_DIR, "ins-overlap.txt"), "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const before = await exec("read", { path: "ins-overlap.txt" });
		const result = await exec("edit", {
			path: "ins-overlap.txt",
			ops: [
				{ op: "insert_after", anchor: anchorForLine(before.content, 5), content: "INSERTED" },
				{
					op: "replace",
					anchor: anchorForLine(before.content, 3),
					end_anchor: anchorForLine(before.content, 7),
					content: "REPLACED",
				},
			],
		});
		expect(result.isError).toBe(true);
		expect(result.content.toLowerCase()).toContain("overlap");
		expect(readFileSync(join(TEST_DIR, "ins-overlap.txt"), "utf-8")).toBe("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n");
	});

	it("allows an insert_after anchored on the last line of a replace range", async () => {
		writeFileSync(join(TEST_DIR, "ins-edge.txt"), "l1\nl2\nl3\nl4\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const before = await exec("read", { path: "ins-edge.txt" });
		const result = await exec("edit", {
			path: "ins-edge.txt",
			ops: [
				{ op: "insert_after", anchor: anchorForLine(before.content, 3), content: "AFTER" },
				{
					op: "replace",
					anchor: anchorForLine(before.content, 2),
					end_anchor: anchorForLine(before.content, 3),
					content: "R1\nR2",
				},
			],
		});
		expect(result.isError).toBeFalsy();
		expect(readFileSync(join(TEST_DIR, "ins-edge.txt"), "utf-8")).toBe("l1\nR1\nR2\nAFTER\nl4\n");
	});

	it("deletes a line range when replace content is empty", async () => {
		writeFileSync(join(TEST_DIR, "delete.txt"), "a\nb\nc\nd\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const before = await exec("read", { path: "delete.txt" });
		const result = await exec("edit", {
			path: "delete.txt",
			ops: [
				{
					op: "replace",
					anchor: anchorForLine(before.content, 2),
					end_anchor: anchorForLine(before.content, 3),
					content: "",
				},
			],
		});
		expect(result.isError).toBeFalsy();
		expect(readFileSync(join(TEST_DIR, "delete.txt"), "utf-8")).toBe("a\nd\n");
	});

	it("rejects the old edits[] shape with a clear error", async () => {
		// The shim was dropped: the only accepted shape is ops[] with anchors.
		// Models trained on other harnesses that still send oldText/newText
		// get a pointed error so they can reissue with anchors.
		writeFileSync(join(TEST_DIR, "oldshape.txt"), "hello world\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", {
			path: "oldshape.txt",
			edits: [{ oldText: "hello world", newText: "goodbye world" }],
		});
		expect(result.isError).toBe(true);
		expect(result.content).toContain("ops[]");
		expect(readFileSync(join(TEST_DIR, "oldshape.txt"), "utf-8")).toBe("hello world\n");
	});

	it("rejects unknown op kinds", async () => {
		writeFileSync(join(TEST_DIR, "badop.txt"), "x\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", {
			path: "badop.txt",
			ops: [{ op: "splode", anchor: "1:deadbe", content: "y" }],
		});
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Unknown edit op");
	});

	it("rejects replace without an anchor", async () => {
		writeFileSync(join(TEST_DIR, "noanchor.txt"), "x\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", {
			path: "noanchor.txt",
			ops: [{ op: "replace", content: "y" }],
		});
		expect(result.isError).toBe(true);
		expect(result.content).toContain("anchor");
	});

	it("rejects empty path", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", { path: "", ops: [{ op: "replace", anchor: "1:deadbe", content: "b" }] });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("path");
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

	it("returns 'No matches found' for a pattern that matches nothing (rg exit 1)", async () => {
		writeFileSync(join(TEST_DIR, "grep.txt"), "hello world\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("grep", { pattern: "zzz_definitely_absent_zzz", path: TEST_DIR });
		expect(result.content).toBe("No matches found");
		expect(result.isError).toBeUndefined();
	});
});

describe("grep permission diagnostics", () => {
	it("isPermissionError recognizes EPERM/EACCES but not ENOENT", () => {
		expect(isPermissionError({ code: "EPERM" })).toBe(true);
		expect(isPermissionError({ code: "EACCES" })).toBe(true);
		expect(isPermissionError({ code: "ENOENT" })).toBe(false);
		expect(isPermissionError(new Error("nope"))).toBe(false);
		expect(isPermissionError(undefined)).toBe(false);
	});

	it("withAccessNote appends a note when the fallback skipped paths for permissions", () => {
		const out = withAccessNote("src/a.ts:1:hit", "", 2);
		expect(out).toContain("src/a.ts:1:hit");
		expect(out).toContain("2 path(s) skipped");
		expect(out).toContain("Full Disk Access");
	});

	it("withAccessNote appends a note when rg's stderr reported permission denied", () => {
		const out = withAccessNote("No matches found", "rg: /Users/x/Documents: Operation not permitted (os error 1)", 0);
		expect(out).toContain("No matches found");
		expect(out).toContain("skipped — permission denied");
	});

	it("withAccessNote is a no-op when nothing was blocked", () => {
		expect(withAccessNote("clean output", "", 0)).toBe("clean output");
	});
});

// ============================================================================
// brace expansion in glob patterns
// ============================================================================

describe("brace expansion", () => {
	it("expands {a,b} to match alternatives", async () => {
		writeFileSync(join(TEST_DIR, "a.ts"), "");
		writeFileSync(join(TEST_DIR, "b.js"), "");
		writeFileSync(join(TEST_DIR, "c.css"), "");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("find", { pattern: "*.{ts,js}", path: TEST_DIR });
		expect(result.content).toContain("a.ts");
		expect(result.content).toContain("b.js");
		expect(result.content).not.toContain("c.css");
	});

	it("expands {a,b,c} with three alternatives", async () => {
		writeFileSync(join(TEST_DIR, "x.ts"), "");
		writeFileSync(join(TEST_DIR, "y.js"), "");
		writeFileSync(join(TEST_DIR, "z.css"), "");
		writeFileSync(join(TEST_DIR, "w.md"), "");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("find", { pattern: "*.{ts,js,md}", path: TEST_DIR });
		expect(result.content).toContain("x.ts");
		expect(result.content).toContain("y.js");
		expect(result.content).toContain("w.md");
		expect(result.content).not.toContain("z.css");
	});

	it("handles nested globs inside braces", async () => {
		writeFileSync(join(TEST_DIR, "test.spec.ts"), "");
		writeFileSync(join(TEST_DIR, "test.test.ts"), "");
		writeFileSync(join(TEST_DIR, "bare.ts"), "");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("find", { pattern: "*.{spec,test}.ts", path: TEST_DIR });
		expect(result.content).toContain("test.spec.ts");
		expect(result.content).toContain("test.test.ts");
		expect(result.content).not.toContain("bare.ts");
	});

	it("treats unmatched { as literal", async () => {
		writeFileSync(join(TEST_DIR, "a{b"), "");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("find", { pattern: "a{b", path: TEST_DIR });
		expect(result.content).toContain("a{b");
	});
});

// ============================================================================
// symlink cycle detection
// ============================================================================

describe("symlink cycle detection", () => {
	it("does not loop on circular symlinks", async () => {
		const dirA = join(TEST_DIR, "a");
		const dirB = join(dirA, "b");
		mkdirSync(dirB, { recursive: true });
		writeFileSync(join(dirA, "file.txt"), "");
		// dirA/b/link -> dirA (cycle!)
		symlinkSync(dirA, join(dirB, "link"));

		const exec = createToolExecutor(TEST_DIR, mockConfig);
		// Should complete without hanging
		const result = await exec("find", { pattern: "*.txt", path: TEST_DIR, timeout: 5 });
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("file.txt");
	});

	it("follows symlinks but does not revisit targets", async () => {
		const realDir = join(TEST_DIR, "real");
		const linkDir = join(TEST_DIR, "link");
		mkdirSync(realDir);
		writeFileSync(join(realDir, "data.txt"), "");
		symlinkSync(realDir, linkDir);

		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("find", { pattern: "data.txt", path: TEST_DIR });
		// Should find data.txt once (via real/ or link/), not loop
		expect(result.content).toContain("data.txt");
	});

	it("handles self-referencing symlink", async () => {
		const selfDir = join(TEST_DIR, "self");
		mkdirSync(selfDir);
		writeFileSync(join(selfDir, "ok.txt"), "");
		symlinkSync(selfDir, join(selfDir, "loop"));

		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("find", { pattern: "ok.txt", path: TEST_DIR, timeout: 5 });
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("ok.txt");
	});
});

// ============================================================================
// gitignore: negation and nested .gitignore
// ============================================================================

describe("gitignore negation", () => {
	it("ignores files matching a pattern", async () => {
		writeFileSync(join(TEST_DIR, ".gitignore"), "*.log");
		writeFileSync(join(TEST_DIR, "app.log"), "");
		writeFileSync(join(TEST_DIR, "app.ts"), "");

		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("find", { pattern: "*", path: TEST_DIR });
		expect(result.content).toContain("app.ts");
		expect(result.content).not.toContain("app.log");
	});

	it("un-ignores files with negation pattern", async () => {
		writeFileSync(join(TEST_DIR, ".gitignore"), "*.log\n!important.log");
		writeFileSync(join(TEST_DIR, "debug.log"), "");
		writeFileSync(join(TEST_DIR, "important.log"), "");
		writeFileSync(join(TEST_DIR, "app.ts"), "");

		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("find", { pattern: "*", path: TEST_DIR });
		expect(result.content).toContain("app.ts");
		expect(result.content).toContain("important.log");
		expect(result.content).not.toContain("debug.log");
	});

	it("last matching rule wins", async () => {
		writeFileSync(join(TEST_DIR, ".gitignore"), "*.txt\n!important.txt\n*.txt");
		writeFileSync(join(TEST_DIR, "file.txt"), "");

		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("find", { pattern: "*.txt", path: TEST_DIR });
		expect(result.content).not.toContain("file.txt");
	});
});

describe("nested .gitignore", () => {
	it("applies rules from nested .gitignore in subdirectories", async () => {
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(join(TEST_DIR, "src", ".gitignore"), "*.tmp");
		writeFileSync(join(TEST_DIR, "src", "app.ts"), "");
		writeFileSync(join(TEST_DIR, "src", "cache.tmp"), "");
		writeFileSync(join(TEST_DIR, "root.tmp"), "");

		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("find", { pattern: "*.tmp", path: TEST_DIR });
		// src/.gitignore ignores *.tmp only under src/
		expect(result.content).toContain("root.tmp");
		expect(result.content).not.toContain("cache.tmp");
	});

	it("inherits parent rules and adds nested rules", async () => {
		writeFileSync(join(TEST_DIR, ".gitignore"), "*.log");
		mkdirSync(join(TEST_DIR, "sub"), { recursive: true });
		writeFileSync(join(TEST_DIR, "sub", ".gitignore"), "*.tmp");
		writeFileSync(join(TEST_DIR, "sub", "app.ts"), "");
		writeFileSync(join(TEST_DIR, "sub", "debug.log"), "");
		writeFileSync(join(TEST_DIR, "sub", "cache.tmp"), "");

		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("find", { pattern: "*", path: TEST_DIR });
		expect(result.content).toContain("app.ts");
		expect(result.content).not.toContain("debug.log"); // root rule
		expect(result.content).not.toContain("cache.tmp"); // nested rule
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

// ============================================================================
// task
// ============================================================================

describe("task", () => {
	it("returns error when taskDeps not configured", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("task", { assignment: "do something" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("not available");
	});

	it("returns error for missing assignment", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, {
			model: "test",
			subagentPrompts: [],
			runAgentLoop: async () => {
				throw new Error("should not be called");
			},
		});
		const result = await exec("task", {});
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Missing");
	});

	it("returns error for unknown subagent", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, {
			model: "test",
			subagentPrompts: [
				{
					name: "worker",
					label: "Worker",
					description: "test",
					systemPrompt: "test",
				},
			],
			runAgentLoop: async () => {
				throw new Error("should not be called");
			},
		});
		const result = await exec("task", { assignment: "do something", subagent: "nonexistent" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Unknown subagent");
	});

	it("child loop receives no personas — cannot delegate further", async () => {
		let capturedConfig: Record<string, unknown> | undefined;
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, {
			model: "test",
			subagentPrompts: [
				{
					name: "worker",
					label: "Worker",
					description: "test",
					systemPrompt: "worker prompt",
				},
			],
			runAgentLoop: async (_msgs, config) => {
				capturedConfig = config as Record<string, unknown>;
				return [{ role: "assistant", content: "done" }];
			},
		});
		await exec("task", { assignment: "test task" });
		expect(capturedConfig?.personas).toBeUndefined();
		expect(capturedConfig?.currentPersona).toBeUndefined();
		expect(capturedConfig?.subagentPrompts).toBeUndefined();
		expect(capturedConfig?.subagentModel).toBeUndefined();
	});

	it("defaults to the 'worker' subagent even when another sorts earlier", async () => {
		let capturedConfig: Record<string, unknown> | undefined;
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, {
			model: "test",
			// "analyst" sorts before "worker"; the default must still be worker.
			subagentPrompts: [
				{ name: "analyst", label: "Analyst", description: "x", systemPrompt: "analyst prompt" },
				{ name: "worker", label: "Worker", description: "x", systemPrompt: "worker prompt" },
			],
			runAgentLoop: async (_msgs, config) => {
				capturedConfig = config as Record<string, unknown>;
				return [{ role: "assistant", content: "done" }];
			},
		});
		await exec("task", { assignment: "do it" }); // no persona → default
		expect(capturedConfig?.systemPrompt).toBe("worker prompt");
	});

	it("passes the assignment only in the user message, not the system prompt", async () => {
		let capturedConfig: Record<string, unknown> | undefined;
		let capturedMessages: unknown;
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, {
			model: "test",
			subagentPrompts: [{ name: "worker", label: "Worker", description: "test", systemPrompt: "worker prompt" }],
			runAgentLoop: async (msgs, config) => {
				capturedMessages = msgs;
				capturedConfig = config as Record<string, unknown>;
				return [{ role: "assistant", content: "done" }];
			},
		});
		await exec("task", { assignment: "unique-assignment-token" });
		expect(capturedConfig?.systemPrompt).toBe("worker prompt");
		expect(capturedConfig?.systemPrompt).not.toContain("unique-assignment-token");
		expect(JSON.stringify(capturedMessages)).toContain("unique-assignment-token");
	});

	it("surfaces a non-stop end reason as an error", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, {
			model: "test",
			subagentPrompts: [{ name: "worker", label: "Worker", description: "test", systemPrompt: "worker prompt" }],
			runAgentLoop: async (_msgs, config) => {
				config.onEvent?.({ type: "end", reason: "aborted" });
				return [{ role: "assistant", content: "partial" }];
			},
		});
		const result = await exec("task", { assignment: "do it" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("aborted");
		expect(result.content).toContain("partial");
	});

	it("propagates provider-reported subagent cost in subagentUsage", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, {
			model: "test",
			subagentPrompts: [{ name: "worker", label: "Worker", description: "test", systemPrompt: "worker prompt" }],
			runAgentLoop: async (_msgs, config) => {
				config.onEvent?.({
					type: "usage",
					usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0.002 },
				});
				config.onEvent?.({
					type: "usage",
					usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28, cost: 0.003 },
				});
				config.onEvent?.({ type: "end", reason: "stop" });
				return [{ role: "assistant", content: "done" }];
			},
		});
		const result = await exec("task", { assignment: "do it" });
		expect(result.isError).toBeFalsy();
		expect(result.subagentUsage?.cost).toBeCloseTo(0.005);
	});

	it("flags an empty result as an error even when the run finished", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, {
			model: "test",
			subagentPrompts: [{ name: "worker", label: "Worker", description: "test", systemPrompt: "worker prompt" }],
			runAgentLoop: async (_msgs, config) => {
				config.onEvent?.({ type: "end", reason: "stop" });
				return [{ role: "assistant", content: "   " }];
			},
		});
		const result = await exec("task", { assignment: "do it" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("no output");
	});

	it("caps concurrent subagents at 10", async () => {
		let active = 0;
		let peak = 0;
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, {
			model: "test",
			subagentPrompts: [{ name: "worker", label: "Worker", description: "test", systemPrompt: "worker prompt" }],
			runAgentLoop: async () => {
				active++;
				peak = Math.max(peak, active);
				await gate;
				active--;
				return [{ role: "assistant", content: "done" }];
			},
		});
		const runs = Array.from({ length: 25 }, () => exec("task", { assignment: "work" }));
		// Let the semaphore admit its first wave before releasing the gate.
		await new Promise((r) => setTimeout(r, 20));
		expect(peak).toBe(10);
		release();
		await Promise.all(runs);
		expect(peak).toBe(10);
	});

	it("cancels queued subagents immediately when the signal aborts (no slot wait)", async () => {
		const ac = new AbortController();
		let started = 0;
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, {
			model: "test",
			subagentPrompts: [{ name: "worker", label: "Worker", description: "x", systemPrompt: "worker prompt" }],
			runAgentLoop: async () => {
				started++;
				await gate; // the 10 admitted runs park here, holding every slot
				return [{ role: "assistant", content: "done" }];
			},
		});
		// 10 fill the cap and block; 3 more queue behind the semaphore.
		const runs = Array.from({ length: 13 }, () => exec("task", { assignment: "work" }, ac.signal));
		await new Promise((r) => setTimeout(r, 20));
		expect(started).toBe(10); // only the cap started; 3 are queued

		ac.abort();
		const results = await Promise.all(runs.slice(10)); // the 3 queued ones
		// They resolve right away as aborted errors, without waiting for a slot.
		for (const r of results) {
			expect(r.isError).toBe(true);
			expect(r.content).toContain("aborted");
		}
		expect(started).toBe(10); // none of the queued runs ever entered the loop

		release();
		await Promise.all(runs.slice(0, 10));
	});

	it("serializes confirmBash across concurrent subagents", async () => {
		let confirmActive = 0;
		let confirmPeak = 0;
		const confirm = async (): Promise<boolean> => {
			confirmActive++;
			confirmPeak = Math.max(confirmPeak, confirmActive);
			await new Promise((r) => setTimeout(r, 10));
			confirmActive--;
			return true;
		};
		const exec = createToolExecutor(TEST_DIR, mockConfig, confirm, {
			model: "test",
			subagentPrompts: [{ name: "worker", label: "Worker", description: "test", systemPrompt: "worker prompt" }],
			confirmBash: confirm,
			runAgentLoop: async (_msgs, config) => {
				// The child invokes the (wrapped) confirmBash it was handed.
				await config.confirmBash?.("rm -rf x", "dangerous");
				return [{ role: "assistant", content: "done" }];
			},
		});
		const runs = Array.from({ length: 5 }, () => exec("task", { assignment: "work" }));
		await Promise.all(runs);
		expect(confirmPeak).toBe(1);
	});
});

// ============================================================================
// plan tools — executor dispatch and definition invariants
// ============================================================================

describe("plan tools dispatch", () => {
	function planStateInTestDir(): PlanState {
		return { enabled: true, plansDir: join(TEST_DIR, "plans") };
	}

	it("returns 'not available' for every plan tool when no planState is wired (headless, subagents)", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		for (const name of PLAN_TOOL_NAMES) {
			const result = await exec(name, { name: "x", content: "# P", item: "x", reason: "r" });
			expect(result.isError, `${name} must be unavailable without planState`).toBe(true);
			expect(result.content).toContain("not available");
		}
	});

	it("routes the full lifecycle through the real executors when planState is wired", async () => {
		const planState = planStateInTestDir();
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, undefined, planState);

		const write = await exec("plan_write", { name: "lifecycle", content: "# P\n\n## Steps\n- [ ] only step" });
		expect(write.isError).toBeFalsy();
		expect(existsSync(join(TEST_DIR, "plans", "lifecycle.md"))).toBe(true);

		const read = JSON.parse((await exec("plan_read", {})).content);
		expect(read.name).toBe("lifecycle");
		expect(read.plans).toEqual(["lifecycle"]);

		const done = JSON.parse((await exec("plan_done", { summary: "s" })).content);
		expect(done.planReady).toBe(true);

		const check = JSON.parse((await exec("plan_check", { item: "only step" })).content);
		expect(check.allDone).toBe(true);

		const enter = JSON.parse((await exec("plan_enter", { reason: "complex" })).content);
		expect(enter.planSuggested).toBe(true);

		const discard = JSON.parse((await exec("plan_discard", { name: "lifecycle" })).content);
		expect(discard.discarded).toBe("lifecycle");
		expect(existsSync(join(TEST_DIR, "plans", "lifecycle.md"))).toBe(false);
	});
});

describe("plan tool definitions", () => {
	it("every plan_* definition is gated by PLAN_TOOL_NAMES — and vice versa", () => {
		// PLAN_TOOL_NAMES drives the headless and subagent disable lists; a
		// plan tool defined but missing from it would leak into contexts that
		// have no plan mode at all.
		const defined = getToolDefinitions()
			.map((t) => t.function.name)
			.filter((n) => n.startsWith("plan_"));
		expect([...defined].sort()).toEqual([...PLAN_TOOL_NAMES].sort());
	});
});
