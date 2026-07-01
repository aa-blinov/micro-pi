import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addProjectRule,
	deleteProjectRule,
	formatRulesForPrompt,
	hasProjectRules,
	loadRules,
	parseProjectRules,
	readProjectRules,
	saveProjectRules,
} from "../src/core/rules.ts";

describe("rules", () => {
	let realHome: string | undefined;
	let fakeHome: string;
	let projectDir: string;

	beforeEach(() => {
		realHome = process.env.HOME;
		fakeHome = mkdtempSync(join(tmpdir(), "cast-rules-test-"));
		process.env.HOME = fakeHome;
		projectDir = join(fakeHome, "project");
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		process.env.HOME = realHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	describe("loadRules", () => {
		it("returns an empty string when no rules files exist", () => {
			expect(loadRules(projectDir, true)).toBe("");
		});

		it("loads global rules regardless of project trust", () => {
			mkdirSync(join(fakeHome, ".cast"), { recursive: true });
			writeFileSync(join(fakeHome, ".cast", "rules.md"), "Global rule.", "utf-8");
			expect(loadRules(projectDir, false)).toBe("Global rule.");
			expect(loadRules(projectDir, true)).toBe("Global rule.");
		});

		it("loads project rules only when trusted", () => {
			saveProjectRules(projectDir, "Project rule.");
			expect(loadRules(projectDir, false)).toBe("");
			expect(loadRules(projectDir, true)).toBe("Project rule.");
		});

		it("concatenates global and project rules with a blank line between them", () => {
			mkdirSync(join(fakeHome, ".cast"), { recursive: true });
			writeFileSync(join(fakeHome, ".cast", "rules.md"), "Global rule.", "utf-8");
			saveProjectRules(projectDir, "Project rule.");
			expect(loadRules(projectDir, true)).toBe("Global rule.\n\nProject rule.");
		});

		it("skips whitespace-only rules files", () => {
			mkdirSync(join(fakeHome, ".cast"), { recursive: true });
			writeFileSync(join(fakeHome, ".cast", "rules.md"), "   \n\t\n", "utf-8");
			expect(loadRules(projectDir, true)).toBe("");
		});
	});

	describe("formatRulesForPrompt", () => {
		it("returns an empty string when there are no rules", () => {
			expect(formatRulesForPrompt("")).toBe("");
		});

		it("wraps rules in a <rules> block", () => {
			expect(formatRulesForPrompt("Always do X.")).toBe("\n\n<rules>\nAlways do X.\n</rules>");
		});
	});

	describe("hasProjectRules", () => {
		it("is false when the project has no rules.md", () => {
			expect(hasProjectRules(projectDir)).toBe(false);
		});

		it("is true once rules have been saved", () => {
			saveProjectRules(projectDir, "A rule.");
			expect(hasProjectRules(projectDir)).toBe(true);
		});
	});

	describe("saveProjectRules / readProjectRules", () => {
		it("creates .cast/ if missing and round-trips content", () => {
			saveProjectRules(projectDir, "Do the thing.");
			expect(readProjectRules(projectDir)).toBe("Do the thing.");
		});

		it("overwrites existing content rather than appending", () => {
			saveProjectRules(projectDir, "First.");
			saveProjectRules(projectDir, "Second.");
			expect(readProjectRules(projectDir)).toBe("Second.");
		});

		it("readProjectRules returns an empty string when the file is missing", () => {
			expect(readProjectRules(projectDir)).toBe("");
		});
	});

	describe("parseProjectRules", () => {
		it("returns empty array for missing file", () => {
			expect(parseProjectRules(projectDir)).toEqual([]);
		});

		it("parses numbered rules from markdown list", () => {
			saveProjectRules(projectDir, "1. First rule\n2. Second rule\n3. Third rule");
			expect(parseProjectRules(projectDir)).toEqual(["First rule", "Second rule", "Third rule"]);
		});

		it("accepts bare (non-numbered) lines alongside numbered ones", () => {
			saveProjectRules(projectDir, "Header\n1. Only this\nSome text\n2. And this");
			expect(parseProjectRules(projectDir)).toEqual(["Header", "Only this", "Some text", "And this"]);
		});
	});

	describe("addProjectRule", () => {
		it("creates file and adds first rule numbered 1", () => {
			addProjectRule(projectDir, "Be kind");
			expect(readProjectRules(projectDir)).toBe("1. Be kind");
		});

		it("appends and renumbers", () => {
			addProjectRule(projectDir, "First");
			addProjectRule(projectDir, "Second");
			addProjectRule(projectDir, "Third");
			expect(readProjectRules(projectDir)).toBe("1. First\n2. Second\n3. Third");
		});

		it("renumbers broken numbering on next save", () => {
			saveProjectRules(projectDir, "5. Wrong\n9. Also wrong");
			addProjectRule(projectDir, "New");
			expect(readProjectRules(projectDir)).toBe("1. Wrong\n2. Also wrong\n3. New");
		});
	});

	describe("deleteProjectRule", () => {
		it("returns false for out-of-range index", () => {
			saveProjectRules(projectDir, "1. Only");
			expect(deleteProjectRule(projectDir, 0)).toBe(false);
			expect(deleteProjectRule(projectDir, 2)).toBe(false);
		});

		it("deletes and renumbers remaining rules", () => {
			saveProjectRules(projectDir, "1. A\n2. B\n3. C");
			expect(deleteProjectRule(projectDir, 2)).toBe(true);
			expect(readProjectRules(projectDir)).toBe("1. A\n2. C");
		});

		it("produces empty file when last rule is deleted", () => {
			saveProjectRules(projectDir, "1. Only one");
			expect(deleteProjectRule(projectDir, 1)).toBe(true);
			expect(readProjectRules(projectDir)).toBe("");
		});
	});
});
