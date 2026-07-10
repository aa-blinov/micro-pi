/**
 * Subagent prompts — dedicated system prompts for worker agents spawned by
 * the `task` tool. Loaded from `prompts/subagents/*.md` (builtin) with the
 * same frontmatter format as personas (name, label, description).
 *
 * Unlike personas, subagent prompts are not user-facing and have no
 * trust-gated project/global sources — they ship with cast and are
 * selected by the task tool at spawn time.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";
import { promptsDir } from "./prompts.ts";

export interface SubagentPrompt {
	name: string;
	label: string;
	description: string;
	systemPrompt: string;
}

const SUBAGENTS_DIR = join(promptsDir, "subagents");

function loadSubagentFromFile(filePath: string): SubagentPrompt | null {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}

	const { frontmatter, body } = parseFrontmatter(raw);
	const name = typeof frontmatter.name === "string" && frontmatter.name ? frontmatter.name : undefined;
	if (!name) return null;

	return {
		name,
		label: typeof frontmatter.label === "string" && frontmatter.label ? frontmatter.label : name,
		description: typeof frontmatter.description === "string" ? frontmatter.description : "",
		systemPrompt: body.trimEnd(),
	};
}

/**
 * Load all .md subagent prompts from prompts/subagents/. Returns them
 * sorted by name. Silently returns an empty array if the directory
 * doesn't exist.
 */
export function loadSubagentPrompts(): SubagentPrompt[] {
	let files: string[];
	try {
		files = readdirSync(SUBAGENTS_DIR).filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}
	return files
		.map((f) => loadSubagentFromFile(join(SUBAGENTS_DIR, f)))
		.filter((p): p is SubagentPrompt => p !== null)
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Find a subagent prompt by name. Falls back to undefined if not found.
 */
export function findSubagentPrompt(name: string, all: SubagentPrompt[]): SubagentPrompt | undefined {
	return all.find((p) => p.name === name);
}
