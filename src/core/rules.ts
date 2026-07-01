/**
 * Project rules (rules.md) — user-authored instructions appended to the
 * system prompt. Global rules (~/.cast/rules.md) always load; project
 * rules (<cwd>/.cast/rules.md) are gated behind the unified project
 * trust decision, same as skills and context files.
 *
 * Project rules are stored as a numbered markdown list and managed via the
 * /rules, /rules add, and /rules delete commands.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const RULES_FILENAME = "rules.md";

function globalRulesPath(): string {
	return join(process.env.HOME ?? ".", ".cast", RULES_FILENAME);
}

function projectRulesPath(cwd: string): string {
	return join(cwd, ".cast", RULES_FILENAME);
}

/**
 * Load and concatenate rules from global and project paths. Returns an
 * empty string when no rules files exist.
 */
export function loadRules(cwd: string, projectTrusted: boolean): string {
	const parts: string[] = [];

	const global = globalRulesPath();
	if (existsSync(global)) {
		try {
			const content = readFileSync(global, "utf-8").trim();
			if (content) parts.push(content);
		} catch {
			// Unreadable — skip silently.
		}
	}

	if (projectTrusted) {
		const project = projectRulesPath(cwd);
		if (existsSync(project)) {
			try {
				const content = readFileSync(project, "utf-8").trim();
				if (content) parts.push(content);
			} catch {
				// Unreadable — skip silently.
			}
		}
	}

	return parts.join("\n\n");
}

/**
 * Format rules into a system prompt section. Returns an empty string when
 * there are no rules.
 */
export function formatRulesForPrompt(rules: string): string {
	if (!rules) return "";
	return `\n\n<rules>\n${rules}\n</rules>`;
}

/**
 * Check whether the project has a rules.md file. Used by the trust prompt
 * to decide whether to mention rules in its resource listing.
 */
export function hasProjectRules(cwd: string): boolean {
	return existsSync(projectRulesPath(cwd));
}

/** Write rules content to the project's rules.md, creating .cast/ if needed. */
export function saveProjectRules(cwd: string, content: string): void {
	const path = projectRulesPath(cwd);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf-8");
}

/**
 * Ensure the project's rules.md exists (creating .cast/ and an empty
 * file if needed) and return its path.
 */
export function ensureProjectRulesFile(cwd: string): string {
	const path = projectRulesPath(cwd);
	mkdirSync(dirname(path), { recursive: true });
	if (!existsSync(path)) writeFileSync(path, "", "utf-8");
	return path;
}

/**
 * Parse a rules.md body into an array of rule texts. Accepts both numbered
 * lines ("1. text") and bare lines ("text"). Blank lines and lines that
 * look like markdown headings are skipped. The original numbering is
 * discarded — callers always re-number on save.
 */
function parseRulesBody(content: string): string[] {
	if (!content) return [];
	const rules: string[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		// Strip leading "N. " if present.
		const match = trimmed.match(/^\d+\.\s(.+)$/);
		rules.push(match ? match[1]! : trimmed);
	}
	return rules;
}

/**
 * Parse project rules from rules.md. Accepts numbered and bare lines.
 * Returns an empty array when the file is missing or empty.
 */
export function parseProjectRules(cwd: string): string[] {
	return parseRulesBody(readProjectRules(cwd));
}

/**
 * Append a new rule to the project's rules.md, auto-numbering it. Creates
 * the file and .cast/ directory if needed.
 */
export function addProjectRule(cwd: string, text: string): void {
	const rules = parseProjectRules(cwd);
	rules.push(text);
	const numbered = rules.map((r, i) => `${i + 1}. ${r}`).join("\n");
	saveProjectRules(cwd, numbered);
}

/**
 * Delete a rule by its 1-based number from the project's rules.md and
 * renumber the remaining rules. Returns false if the number is out of range.
 */
export function deleteProjectRule(cwd: string, num: number): boolean {
	const rules = parseProjectRules(cwd);
	if (num < 1 || num > rules.length) return false;
	rules.splice(num - 1, 1);
	const numbered = rules.map((r, i) => `${i + 1}. ${r}`).join("\n");
	saveProjectRules(cwd, numbered);
	return true;
}

/** Read the project's rules.md, returning empty string if missing. */
export function readProjectRules(cwd: string): string {
	const path = projectRulesPath(cwd);
	if (!existsSync(path)) return "";
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

/** Read the global rules.md, returning empty string if missing. Unlike
 * project rules, global rules are never gated behind trust — they always
 * load (see loadRules) — so this has no trust parameter to worry about.
 */
export function readGlobalRules(): string {
	const path = globalRulesPath();
	if (!existsSync(path)) return "";
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

function saveGlobalRules(content: string): void {
	const path = globalRulesPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf-8");
}

export function parseGlobalRules(): string[] {
	return parseRulesBody(readGlobalRules());
}

export function addGlobalRule(text: string): void {
	const rules = parseGlobalRules();
	rules.push(text);
	const numbered = rules.map((r, i) => `${i + 1}. ${r}`).join("\n");
	saveGlobalRules(numbered);
}

export function deleteGlobalRule(num: number): boolean {
	const rules = parseGlobalRules();
	if (num < 1 || num > rules.length) return false;
	rules.splice(num - 1, 1);
	const numbered = rules.map((r, i) => `${i + 1}. ${r}`).join("\n");
	saveGlobalRules(numbered);
	return true;
}
