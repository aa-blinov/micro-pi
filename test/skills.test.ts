import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatSkillInvocation, formatSkillsForPrompt, loadSkills } from "../src/core/skills.ts";

const TEST_DIR = join(import.meta.dirname, "__test_tmp_skills__");
const GLOBAL_DIR = join(TEST_DIR, "global");
const PROJECT_DIR = join(TEST_DIR, "project");

function writeSkill(dir: string, relPath: string, frontmatter: Record<string, string>, body = "Do the thing."): void {
	const fullPath = join(dir, relPath);
	mkdirSync(join(fullPath, ".."), { recursive: true });
	const fm = Object.entries(frontmatter)
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n");
	writeFileSync(fullPath, `---\n${fm}\n---\n\n${body}\n`, "utf-8");
}

beforeEach(() => {
	mkdirSync(GLOBAL_DIR, { recursive: true });
	mkdirSync(PROJECT_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("loadSkills discovery", () => {
	it("loads a skill from a SKILL.md subdirectory", () => {
		writeSkill(GLOBAL_DIR, "my-skill/SKILL.md", { name: "my-skill", description: "Does a thing." });
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills.map((s) => s.name)).toEqual(["my-skill"]);
	});

	it("loads a direct root .md file as a standalone skill", () => {
		writeSkill(GLOBAL_DIR, "standalone.md", { name: "standalone", description: "A loose skill file." });
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills.map((s) => s.name)).toEqual(["standalone"]);
	});

	it("ignores .md files in subdirectories that have no SKILL.md", () => {
		writeSkill(GLOBAL_DIR, "not-a-skill/notes.md", { name: "notes", description: "Should not load." });
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills).toHaveLength(0);
	});

	it("stops recursing once it finds SKILL.md, ignoring sibling .md files", () => {
		writeSkill(GLOBAL_DIR, "my-skill/SKILL.md", { name: "my-skill", description: "Does a thing." });
		writeFileSync(join(GLOBAL_DIR, "my-skill", "extra.md"), "not a skill", "utf-8");
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills.map((s) => s.name)).toEqual(["my-skill"]);
	});

	it("skips node_modules and dotfile directories", () => {
		writeSkill(GLOBAL_DIR, "node_modules/pkg/SKILL.md", { name: "pkg", description: "Should not load." });
		writeSkill(GLOBAL_DIR, ".hidden/SKILL.md", { name: "hidden", description: "Should not load." });
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills).toHaveLength(0);
	});

	it("falls back to the parent directory name when frontmatter has no name", () => {
		writeSkill(GLOBAL_DIR, "fallback-name/SKILL.md", { description: "No name field." });
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills.map((s) => s.name)).toEqual(["fallback-name"]);
	});

	it("drops a skill with a missing description, with a diagnostic", () => {
		writeSkill(GLOBAL_DIR, "no-desc/SKILL.md", { name: "no-desc" });
		const { skills, diagnostics } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills).toHaveLength(0);
		expect(diagnostics.some((d) => d.message.includes("description"))).toBe(true);
	});

	it("still loads a skill with an invalid name, but warns", () => {
		writeSkill(GLOBAL_DIR, "Invalid-Name/SKILL.md", { name: "Invalid-Name", description: "Uppercase name." });
		const { skills, diagnostics } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills).toHaveLength(1);
		expect(diagnostics.some((d) => d.message.includes("lowercase"))).toBe(true);
	});

	it("keeps the global skill on a name collision with a project skill, with a diagnostic", () => {
		writeSkill(GLOBAL_DIR, "shared/SKILL.md", { name: "shared", description: "Global version." });
		writeSkill(PROJECT_DIR, "shared/SKILL.md", { name: "shared", description: "Project version." });
		const { skills, diagnostics } = loadSkills({ globalDir: GLOBAL_DIR, projectDir: PROJECT_DIR, extraPaths: [] });
		expect(skills).toHaveLength(1);
		expect(skills[0]?.description).toBe("Global version.");
		expect(diagnostics.some((d) => d.message.includes("collision"))).toBe(true);
	});

	it("loads an explicit --skill path even when it's outside global/project dirs", () => {
		const explicitDir = join(TEST_DIR, "explicit");
		writeSkill(explicitDir, "extra/SKILL.md", { name: "extra", description: "Loaded via --skill." });
		const { skills } = loadSkills({ extraPaths: [join(explicitDir, "extra")] });
		expect(skills.map((s) => s.name)).toEqual(["extra"]);
	});

	it("omits global/project dirs entirely when not provided (--no-skills)", () => {
		writeSkill(GLOBAL_DIR, "my-skill/SKILL.md", { name: "my-skill", description: "Does a thing." });
		const { skills } = loadSkills({ extraPaths: [] });
		expect(skills).toHaveLength(0);
	});
});

describe("formatSkillsForPrompt", () => {
	it("includes name/description/location for visible skills", () => {
		writeSkill(GLOBAL_DIR, "my-skill/SKILL.md", { name: "my-skill", description: "Does a thing." });
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		const prompt = formatSkillsForPrompt(skills);
		expect(prompt).toContain("<name>my-skill</name>");
		expect(prompt).toContain("<description>Does a thing.</description>");
		expect(prompt).toContain(join(GLOBAL_DIR, "my-skill", "SKILL.md"));
	});

	it("excludes skills with disable-model-invocation: true", () => {
		writeSkill(GLOBAL_DIR, "manual-only/SKILL.md", {
			name: "manual-only",
			description: "Only via /skill:name.",
			"disable-model-invocation": "true",
		});
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills).toHaveLength(1);
		expect(formatSkillsForPrompt(skills)).toBe("");
	});

	it("returns an empty string when there are no skills", () => {
		expect(formatSkillsForPrompt([])).toBe("");
	});
});

describe("formatSkillInvocation", () => {
	it("wraps the skill body in a <skill> block, appending user args", () => {
		writeSkill(
			GLOBAL_DIR,
			"my-skill/SKILL.md",
			{ name: "my-skill", description: "Does a thing." },
			"Step 1. Step 2.",
		);
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		const invocation = formatSkillInvocation(skills[0]!, "extra instructions");
		expect(invocation).toContain('<skill name="my-skill"');
		expect(invocation).toContain("Step 1. Step 2.");
		expect(invocation).toContain("User: extra instructions");
	});
});
