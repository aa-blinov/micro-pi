/**
 * Agent Skills (https://agentskills.io/specification) — self-contained
 * capability packages the agent loads on demand. Mirrors pi's implementation
 * (packages/coding-agent/src/core/skills.ts in the pi-mono monorepo):
 * directories with a SKILL.md (frontmatter + instructions), discovered from
 * a global dir, a project dir, and explicit --skill paths, then summarized
 * into the system prompt so the model knows what's available without paying
 * for the full content until it actually reads one.
 *
 * Frontmatter is parsed by the shared minimal parser in frontmatter.ts (see
 * that module for why it's not full YAML).
 */

import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./frontmatter.ts";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

// Instructions injected into the system prompt alongside the discovered
// skill list — content, not code, so it lives in prompts/ with the other
// prompt files instead of as inline strings here.
const _selfDir = dirname(fileURLToPath(import.meta.url));
const _promptsDir = existsSync(join(_selfDir, "..", "prompts"))
	? join(_selfDir, "..", "prompts")
	: join(_selfDir, "..", "..", "prompts");
const SKILLS_INSTRUCTIONS = readFileSync(join(_promptsDir, "skills-instructions.md"), "utf-8").trim();

export type SkillSource = "global" | "project" | "path";

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	/** Directory containing the skill file — relative paths inside it resolve against this. */
	baseDir: string;
	source: SkillSource;
	disableModelInvocation: boolean;
}

export interface SkillDiagnostic {
	message: string;
	path: string;
}

/** Read a skill's body (frontmatter stripped) fresh from disk, for /skill:name invocation. */
function readSkillBody(skill: Skill): string {
	return parseFrontmatter(readFileSync(skill.filePath, "utf-8")).body;
}

// ============================================================================
// Validation — per the Agent Skills spec; violations warn but still load,
// except a missing description, which drops the skill entirely (pi's rule).
// ============================================================================

function validateSkillName(name: string): string[] {
	const errors: string[] = [];
	if (name.length > MAX_NAME_LENGTH) errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	if (!/^[a-z0-9-]+$/.test(name)) errors.push("name must be lowercase a-z, 0-9, hyphens only");
	if (name.startsWith("-") || name.endsWith("-")) errors.push("name must not start or end with a hyphen");
	if (name.includes("--")) errors.push("name must not contain consecutive hyphens");
	return errors;
}

function validateSkillDescription(description: string | undefined): string[] {
	if (!description || description.trim() === "") return ["description is required"];
	if (description.length > MAX_DESCRIPTION_LENGTH) return [`description exceeds ${MAX_DESCRIPTION_LENGTH} characters`];
	return [];
}

// ============================================================================
// Discovery
// ============================================================================

function loadSkillFromFile(
	filePath: string,
	source: SkillSource,
): { skill: Skill | null; diagnostics: SkillDiagnostic[] } {
	const diagnostics: SkillDiagnostic[] = [];

	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch (error) {
		diagnostics.push({ message: error instanceof Error ? error.message : String(error), path: filePath });
		return { skill: null, diagnostics };
	}

	const { frontmatter } = parseFrontmatter(raw);
	const parentDirName = basename(dirname(filePath));
	const name = typeof frontmatter.name === "string" && frontmatter.name ? frontmatter.name : parentDirName;
	const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined;

	for (const error of validateSkillDescription(description)) diagnostics.push({ message: error, path: filePath });
	for (const error of validateSkillName(name)) diagnostics.push({ message: error, path: filePath });

	if (!description || description.trim() === "") return { skill: null, diagnostics };

	return {
		skill: {
			name,
			description,
			filePath,
			baseDir: dirname(filePath),
			source,
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		},
		diagnostics,
	};
}

/**
 * Discovery rule (matches pi): if a directory contains SKILL.md, it's a skill
 * root and recursion stops there. Otherwise, direct .md children at this
 * level are loaded as standalone skills, and subdirectories recurse looking
 * for SKILL.md (but their own root .md files are ignored, only SKILL.md
 * counts below the top level).
 */
function loadSkillsFromDirInternal(
	dir: string,
	source: SkillSource,
	includeRootFiles: boolean,
): { skills: Skill[]; diagnostics: SkillDiagnostic[] } {
	const skills: Skill[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	if (!existsSync(dir)) return { skills, diagnostics };

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		diagnostics.push({ message: error instanceof Error ? error.message : String(error), path: dir });
		return { skills, diagnostics };
	}

	if (entries.some((e) => e.name === "SKILL.md" && e.isFile())) {
		const result = loadSkillFromFile(join(dir, "SKILL.md"), source);
		if (result.skill) skills.push(result.skill);
		diagnostics.push(...result.diagnostics);
		return { skills, diagnostics };
	}

	for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const fullPath = join(dir, entry.name);

		if (entry.isDirectory()) {
			const result = loadSkillsFromDirInternal(fullPath, source, false);
			skills.push(...result.skills);
			diagnostics.push(...result.diagnostics);
			continue;
		}

		if (!entry.isFile() || !includeRootFiles || !entry.name.endsWith(".md")) continue;
		const result = loadSkillFromFile(fullPath, source);
		if (result.skill) skills.push(result.skill);
		diagnostics.push(...result.diagnostics);
	}

	return { skills, diagnostics };
}

export interface LoadSkillsOptions {
	/** `~/.cast/skills` — omit only for `--no-skills`; needs no trust prompt (the user put it there themselves). */
	globalDir?: string;
	/** `<cwd>/.cast/skills` — omit entirely if `--no-skills` or the project isn't trusted yet. */
	projectDir?: string;
	/** Explicit `--skill <path>` files or directories — load even with `--no-skills`. */
	extraPaths: string[];
}

/**
 * Load skills from every configured location. On a name collision the
 * first-loaded skill wins (global, then project, then --skill paths, in
 * that order) — matches pi's behavior.
 */
export function loadSkills(options: LoadSkillsOptions): { skills: Skill[]; diagnostics: SkillDiagnostic[] } {
	const skillMap = new Map<string, Skill>();
	const diagnostics: SkillDiagnostic[] = [];

	function addAll(result: { skills: Skill[]; diagnostics: SkillDiagnostic[] }) {
		diagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			if (skillMap.has(skill.name)) {
				diagnostics.push({
					message: `skill name "${skill.name}" collision — keeping the first one loaded`,
					path: skill.filePath,
				});
				continue;
			}
			skillMap.set(skill.name, skill);
		}
	}

	if (options.globalDir) addAll(loadSkillsFromDirInternal(options.globalDir, "global", true));
	if (options.projectDir) addAll(loadSkillsFromDirInternal(options.projectDir, "project", true));

	for (const rawPath of options.extraPaths) {
		if (!existsSync(rawPath)) {
			diagnostics.push({ message: "skill path does not exist", path: rawPath });
			continue;
		}
		const stats = statSync(rawPath);
		if (stats.isDirectory()) {
			addAll(loadSkillsFromDirInternal(rawPath, "path", true));
		} else if (stats.isFile() && rawPath.endsWith(".md")) {
			const result = loadSkillFromFile(rawPath, "path");
			if (result.skill) addAll({ skills: [result.skill], diagnostics: result.diagnostics });
			else diagnostics.push(...result.diagnostics);
		} else {
			diagnostics.push({ message: "skill path is not a markdown file", path: rawPath });
		}
	}

	return { skills: Array.from(skillMap.values()), diagnostics };
}

// ============================================================================
// System prompt injection
// ============================================================================

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** Skills with `disable-model-invocation: true` are omitted — usable only via /skill:name. */
export function formatSkillsForPrompt(skills: Skill[]): string {
	const visible = skills.filter((s) => !s.disableModelInvocation);
	if (visible.length === 0) return "";

	const lines = ["", "", SKILLS_INSTRUCTIONS, "", "<available_skills>"];
	for (const skill of visible) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

/** Format a skill's full content for `/skill:name` invocation, optionally with trailing user args. */
export function formatSkillInvocation(skill: Skill, additionalArgs?: string): string {
	const content = readSkillBody(skill);
	const block = `<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.filePath)}">\nReferences are relative to ${skill.baseDir}.\n\n${content}\n</skill>`;
	return additionalArgs ? `${block}\n\nUser: ${additionalArgs}` : block;
}
