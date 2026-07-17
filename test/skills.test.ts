import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	formatSkillInvocation,
	formatSkillsForPrompt,
	isUninstallableSkill,
	loadSkills,
	uninstallUserSkill,
} from "../src/core/skills.ts";
import { formatSkillPickLabel } from "../src/pickers/domain.ts";

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

	it("keeps the project skill on a name collision with a global skill, with a diagnostic", () => {
		writeSkill(GLOBAL_DIR, "shared/SKILL.md", { name: "shared", description: "Global version." });
		writeSkill(PROJECT_DIR, "shared/SKILL.md", { name: "shared", description: "Project version." });
		const { skills, diagnostics } = loadSkills({ globalDir: GLOBAL_DIR, projectDir: PROJECT_DIR, extraPaths: [] });
		expect(skills).toHaveLength(1);
		expect(skills[0]?.description).toBe("Project version.");
		expect(diagnostics.some((d) => d.message.includes("collision"))).toBe(true);
	});

	it("keeps global over plugin, and plugin over builtin, on name collision", () => {
		const pluginDir = join(TEST_DIR, "plugin");
		const builtinDir = join(TEST_DIR, "builtin");
		mkdirSync(pluginDir, { recursive: true });
		mkdirSync(builtinDir, { recursive: true });
		writeSkill(GLOBAL_DIR, "shared/SKILL.md", { name: "shared", description: "Global version." });
		writeSkill(pluginDir, "shared/SKILL.md", { name: "shared", description: "Plugin version." });
		writeSkill(builtinDir, "shared/SKILL.md", { name: "shared", description: "Builtin version." });

		const globalWins = loadSkills({
			globalDir: GLOBAL_DIR,
			pluginDirs: [pluginDir],
			builtinDir,
			extraPaths: [],
		});
		expect(globalWins.skills).toHaveLength(1);
		expect(globalWins.skills[0]?.description).toBe("Global version.");
		expect(globalWins.skills[0]?.source).toBe("global");

		const pluginWins = loadSkills({
			pluginDirs: [pluginDir],
			builtinDir,
			extraPaths: [],
		});
		expect(pluginWins.skills).toHaveLength(1);
		expect(pluginWins.skills[0]?.description).toBe("Plugin version.");
		expect(pluginWins.skills[0]?.source).toBe("plugin");
	});

	it("stamps pluginId and pluginEnabled from pluginContributions", () => {
		const pluginDir = join(TEST_DIR, "plugin-pack");
		mkdirSync(pluginDir, { recursive: true });
		writeSkill(pluginDir, "alpha/SKILL.md", { name: "alpha", description: "A." });
		writeSkill(pluginDir, "beta/SKILL.md", { name: "beta", description: "B." });
		const { skills } = loadSkills({
			pluginContributions: [{ dir: pluginDir, pluginId: "pack@mp", enabled: false }],
			extraPaths: [],
		});
		expect(skills).toHaveLength(2);
		for (const s of skills) {
			expect(s.pluginId).toBe("pack@mp");
			expect(s.pluginEnabled).toBe(false);
			expect(s.source).toBe("plugin");
		}
	});

	it("returns skills sorted alphabetically by name", () => {
		writeSkill(GLOBAL_DIR, "zeta/SKILL.md", { name: "zeta", description: "Z." });
		writeSkill(GLOBAL_DIR, "alpha/SKILL.md", { name: "alpha", description: "A." });
		writeSkill(GLOBAL_DIR, "mid/SKILL.md", { name: "mid", description: "M." });
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills.map((s) => s.name)).toEqual(["alpha", "mid", "zeta"]);
	});

	it("loads .agents/skills below .cast project and above .cast global", () => {
		const agentsProject = join(TEST_DIR, "agents-project");
		const agentsGlobal = join(TEST_DIR, "agents-global");
		mkdirSync(agentsProject, { recursive: true });
		mkdirSync(agentsGlobal, { recursive: true });
		writeSkill(PROJECT_DIR, "shared/SKILL.md", { name: "shared", description: "Cast project." });
		writeSkill(agentsProject, "shared/SKILL.md", { name: "shared", description: "Agents project." });
		writeSkill(GLOBAL_DIR, "shared/SKILL.md", { name: "shared", description: "Cast global." });
		writeSkill(agentsGlobal, "shared/SKILL.md", { name: "shared", description: "Agents global." });
		writeSkill(agentsGlobal, "only-agents/SKILL.md", { name: "only-agents", description: "From agents global." });

		const castProjectWins = loadSkills({
			projectDir: PROJECT_DIR,
			agentsProjectDir: agentsProject,
			globalDir: GLOBAL_DIR,
			agentsGlobalDirs: [agentsGlobal],
			extraPaths: [],
		});
		expect(castProjectWins.skills.find((s) => s.name === "shared")?.description).toBe("Cast project.");
		expect(castProjectWins.skills.find((s) => s.name === "shared")?.source).toBe("project");

		const agentsProjectWins = loadSkills({
			agentsProjectDir: agentsProject,
			globalDir: GLOBAL_DIR,
			agentsGlobalDirs: [agentsGlobal],
			extraPaths: [],
		});
		expect(agentsProjectWins.skills.find((s) => s.name === "shared")?.description).toBe("Agents project.");
		expect(agentsProjectWins.skills.find((s) => s.name === "shared")?.source).toBe("agents");

		const castGlobalWins = loadSkills({
			globalDir: GLOBAL_DIR,
			agentsGlobalDirs: [agentsGlobal],
			extraPaths: [],
		});
		expect(castGlobalWins.skills.find((s) => s.name === "shared")?.description).toBe("Cast global.");
		expect(castGlobalWins.skills.find((s) => s.name === "only-agents")?.source).toBe("agents");
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

describe("formatSkillPickLabel", () => {
	it("shows plugin provenance and locks pack-off skills", () => {
		const locked = formatSkillPickLabel(
			{
				name: "pony",
				description: "A pony skill.",
				source: "plugin",
				pluginId: "ponytail@ponytail",
				pluginEnabled: false,
				disableModelInvocation: false,
			},
			false,
		);
		expect(locked.label).toBe("pony (plugin · ponytail@ponytail, pack off)");
		expect(locked.locked).toBe(true);
		expect(locked.muted).toBe(true);
		expect(locked.description).toBe("Enable this pack with /plugin first. A pony skill.");

		const on = formatSkillPickLabel(
			{
				name: "pony",
				description: "A pony skill.",
				source: "plugin",
				pluginId: "ponytail@ponytail",
				pluginEnabled: true,
				disableModelInvocation: false,
			},
			true,
		);
		expect(on.label).toBe("pony (plugin · ponytail@ponytail, disabled)");
		expect(on.description).toBe("A pony skill.");
		expect(on.locked).toBe(false);
	});
});

describe("uninstallUserSkill", () => {
	it("removes a directory skill and refuses builtin", () => {
		writeSkill(GLOBAL_DIR, "gone/SKILL.md", { name: "gone", description: "Delete me." });
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		const skill = skills[0]!;
		expect(isUninstallableSkill(skill)).toBe(true);
		uninstallUserSkill(skill);
		expect(existsSync(join(GLOBAL_DIR, "gone"))).toBe(false);

		const builtin = {
			...skill,
			name: "cast",
			source: "builtin" as const,
			filePath: join(GLOBAL_DIR, "cast", "SKILL.md"),
			baseDir: join(GLOBAL_DIR, "cast"),
		};
		expect(isUninstallableSkill(builtin)).toBe(false);
		expect(() => uninstallUserSkill(builtin)).toThrow(/builtin/);

		const agents = { ...skill, source: "agents" as const };
		expect(isUninstallableSkill(agents)).toBe(true);
	});

	it("removes a loose root .md without wiping the skills dir", () => {
		writeSkill(GLOBAL_DIR, "loose.md", { name: "loose", description: "Loose file." });
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		const skill = skills[0]!;
		uninstallUserSkill(skill);
		expect(existsSync(join(GLOBAL_DIR, "loose.md"))).toBe(false);
		expect(existsSync(GLOBAL_DIR)).toBe(true);
	});
});
