import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	formatContextFilesForPrompt,
	hasContextFileInDir,
	loadProjectContextFiles,
} from "../src/core/context-files.ts";

describe("context-files", () => {
	let realHome: string | undefined;
	let fakeHome: string;
	let level1: string;
	let level2: string;

	beforeEach(() => {
		realHome = process.env.HOME;
		fakeHome = mkdtempSync(join(tmpdir(), "cast-context-files-test-"));
		process.env.HOME = fakeHome;
		// level2 (cwd) nested two levels under fakeHome, so we can plant files
		// at both an ancestor (level1) and cwd itself (level2) and tell them apart.
		level1 = join(fakeHome, "level1");
		level2 = join(level1, "level2");
		mkdirSync(level2, { recursive: true });
	});

	afterEach(() => {
		process.env.HOME = realHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	describe("hasContextFileInDir", () => {
		it("is false when the directory has no context file", () => {
			expect(hasContextFileInDir(level2)).toBe(false);
		});

		it("is true once a context file is present", () => {
			writeFileSync(join(level2, "AGENTS.md"), "Instructions.", "utf-8");
			expect(hasContextFileInDir(level2)).toBe(true);
		});

		it("ignores whitespace-only files", () => {
			writeFileSync(join(level2, "AGENTS.md"), "   \n", "utf-8");
			expect(hasContextFileInDir(level2)).toBe(false);
		});
	});

	describe("loadProjectContextFiles", () => {
		it("returns an empty array when nothing exists", () => {
			expect(loadProjectContextFiles(level2, true)).toEqual([]);
		});

		it("includes an ancestor's context file regardless of project trust", () => {
			writeFileSync(join(level1, "AGENTS.md"), "Ancestor rule.", "utf-8");
			const untrusted = loadProjectContextFiles(level2, false);
			const trusted = loadProjectContextFiles(level2, true);
			expect(untrusted.some((f) => f.content === "Ancestor rule.")).toBe(true);
			expect(trusted.some((f) => f.content === "Ancestor rule.")).toBe(true);
		});

		it("includes cwd's own context file only when the project is trusted", () => {
			writeFileSync(join(level2, "CLAUDE.md"), "Cwd rule.", "utf-8");
			const untrusted = loadProjectContextFiles(level2, false);
			const trusted = loadProjectContextFiles(level2, true);
			expect(untrusted.some((f) => f.content === "Cwd rule.")).toBe(false);
			expect(trusted.some((f) => f.content === "Cwd rule.")).toBe(true);
		});

		it("includes the global (~/.cast) context file unconditionally", () => {
			mkdirSync(join(fakeHome, ".cast"), { recursive: true });
			writeFileSync(join(fakeHome, ".cast", "AGENTS.md"), "Global rule.", "utf-8");
			const result = loadProjectContextFiles(level2, false);
			expect(result.some((f) => f.content === "Global rule.")).toBe(true);
		});

		it("orders ancestor files root-first, cwd's own file last", () => {
			writeFileSync(join(level1, "AGENTS.md"), "Ancestor rule.", "utf-8");
			writeFileSync(join(level2, "CLAUDE.md"), "Cwd rule.", "utf-8");
			const result = loadProjectContextFiles(level2, true);
			const contents = result.map((f) => f.content);
			expect(contents.indexOf("Ancestor rule.")).toBeLessThan(contents.indexOf("Cwd rule."));
		});

		it("dedupes when cwd is exactly the global config directory", () => {
			// Running cast from ~/.cast/ itself: the "global" file and
			// the "cwd" file resolve to the same path and must only appear once.
			const cwdIsGlobalDir = join(fakeHome, ".cast");
			mkdirSync(cwdIsGlobalDir, { recursive: true });
			writeFileSync(join(cwdIsGlobalDir, "AGENTS.md"), "Shared.", "utf-8");

			const untrusted = loadProjectContextFiles(cwdIsGlobalDir, false);
			const trusted = loadProjectContextFiles(cwdIsGlobalDir, true);
			expect(untrusted.filter((f) => f.content === "Shared.")).toHaveLength(1);
			expect(trusted.filter((f) => f.content === "Shared.")).toHaveLength(1);
		});

		it("prefers AGENTS.md over CLAUDE.md when both exist in the same directory", () => {
			writeFileSync(join(level2, "AGENTS.md"), "Agents wins.", "utf-8");
			writeFileSync(join(level2, "CLAUDE.md"), "Claude loses.", "utf-8");
			const result = loadProjectContextFiles(level2, true);
			const cwdFile = result.find((f) => f.content.includes("wins") || f.content.includes("loses"));
			expect(cwdFile?.content).toBe("Agents wins.");
		});
	});

	describe("formatContextFilesForPrompt", () => {
		it("returns an empty string when there are no files", () => {
			expect(formatContextFilesForPrompt([])).toBe("");
		});

		it("wraps files in a <project_context> block with escaped paths", () => {
			const result = formatContextFilesForPrompt([{ path: 'a & b "quoted"', content: "Do X." }]);
			expect(result).toContain("<project_context>");
			expect(result).toContain("</project_context>");
			expect(result).toContain('path="a &amp; b &quot;quoted&quot;"');
			expect(result).toContain("Do X.");
		});
	});
});
