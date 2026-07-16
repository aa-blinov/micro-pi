/**
 * Personas — swappable system prompts that give the agent a different role
 * (coding agent, fiction writer, ...) without touching the tool set. The
 * tools (bash/read/write/edit/find/grep/ls) are generic file/shell
 * primitives already, not code-specific in themselves — the persona is
 * entirely a matter of which instructions frame how they're used.
 *
 * Personas are loaded from three sources (highest priority first):
 *   1. Project:  <cwd>/.cast/personas/*.md  (trust-gated, like skills)
 *   2. Global:   ~/.cast/personas/*.md       (always loaded)
 *   3. Builtin:  prompts/personas/*.md       (ships with cast)
 *
 * Same frontmatter format as skills (name, label, description). Only one
 * persona is active at a time; its full body becomes the system prompt.
 * prompts/error-handling.md is appended to every persona (see
 * readSharedErrorHandling below).
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";
import { promptsDir } from "./prompts.ts";

export type PersonaSource = "builtin" | "global" | "project";

export interface Persona {
	name: string;
	label: string;
	description: string;
	systemPrompt: string;
	source: PersonaSource;
	/** Absolute path to the .md file this persona was loaded from. */
	filePath: string;
	/** Whether this persona can use the `task` tool to delegate to sub-agents. Defaults to false. */
	subagents: boolean;
}

export const DEFAULT_PERSONA = "coding";

export const globalPersonasDir = join(homedir(), ".cast", "personas");

const PROMPTS_DIR = promptsDir;

/**
 * Appended to every persona's system prompt, read fresh from
 * prompts/error-handling.md — prompts are content, not code, so this lives
 * alongside the persona files rather than as a string constant here. Tool-
 * failure mechanics (retry on error, check paths, timeouts, permissions)
 * don't depend on the persona's craft/voice — they're the same 7 tools
 * underneath regardless of role, so it's shared instead of copy-pasted into
 * every persona file. Copy-pasting it already caused the two shipped
 * personas' wording to drift from each other once; sharing it means every
 * future persona gets it automatically and identically. Missing the file
 * just omits the section rather than failing the whole persona load.
 */
function readSharedErrorHandling(): string {
	try {
		return readFileSync(join(PROMPTS_DIR, "error-handling.md"), "utf-8").trim();
	} catch {
		return "";
	}
}

/**
 * Mirror of `readSharedErrorHandling` for the hashline `edit` tool. Same
 * rationale: every persona's "**edit**: each `oldText` must match a unique
 * region" line was drifting, and the anchor-based contract is the same
 * regardless of role. The two shared sections are concatenated in
 * `systemPrompt` so each persona gets the same edit/tool guidance.
 */
function readSharedToolGuidance(): string {
	try {
		return readFileSync(join(PROMPTS_DIR, "tools-edit.md"), "utf-8").trim();
	} catch {
		return "";
	}
}

/**
 * Read fresh from prompts/fallback-persona.md, a sibling of prompts/personas/
 * rather than a file inside it — this only ever gets used when
 * prompts/personas/ itself fails to read (a broken/partial install), so it
 * can't rely on anything under that specific directory, but a sibling file
 * is unaffected by that failure and reads fine. If prompts/ itself is gone
 * (a much more broken install than what triggers this path at all), the
 * hardcoded literal below is the true last resort.
 */
function readFallbackPersonaPrompt(): string {
	try {
		return readFileSync(join(PROMPTS_DIR, "fallback-persona.md"), "utf-8").trim();
	} catch {
		return "You are a helpful coding assistant.";
	}
}

const FALLBACK_PERSONA: Persona = {
	name: DEFAULT_PERSONA,
	label: "Coding agent",
	description: "Default persona.",
	systemPrompt: [readFallbackPersonaPrompt(), readSharedErrorHandling(), readSharedToolGuidance()]
		.filter(Boolean)
		.join("\n\n"),
	source: "builtin",
	filePath: "",
	subagents: false,
};

function builtinPersonasDir(): string {
	return join(PROMPTS_DIR, "personas");
}

function loadPersonaFromFile(filePath: string, source: PersonaSource): Persona | null {
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
		systemPrompt: [body.trimEnd(), readSharedErrorHandling(), readSharedToolGuidance()].filter(Boolean).join("\n\n"),
		source,
		filePath,
		subagents: frontmatter.subagents === true,
	};
}

/**
 * Load all .md personas from a directory, returning them sorted by label.
 * Silently returns an empty array if the directory doesn't exist.
 */
function loadPersonasFromDir(dir: string, source: PersonaSource): Persona[] {
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}
	return files
		.map((f) => loadPersonaFromFile(join(dir, f), source))
		.filter((p): p is Persona => p !== null)
		.sort((a, b) => a.label.localeCompare(b.label));
}

export interface LoadPersonasOptions {
	/** `prompts/personas/` — the shipped built-in personas. */
	builtinDir?: string;
	/** `~/.cast/personas/` — always loaded. */
	globalDir?: string;
	/** `<cwd>/.cast/personas/` — omit if project isn't trusted or dir missing. */
	projectDir?: string;
}

/**
 * Load and merge personas from all configured sources. On a name collision
 * the first-loaded persona wins (project, then global, then builtin) —
 * matches the skills collision policy.
 */
export function loadPersonas(options: LoadPersonasOptions = {}): Persona[] {
	const builtinDir = options.builtinDir ?? builtinPersonasDir();
	const personaMap = new Map<string, Persona>();

	// Highest priority first: project > global > builtin.
	const sources: { dir: string | undefined; source: PersonaSource }[] = [
		{ dir: options.projectDir, source: "project" },
		{ dir: options.globalDir, source: "global" },
		{ dir: builtinDir, source: "builtin" },
	];

	for (const { dir, source } of sources) {
		if (!dir) continue;
		for (const persona of loadPersonasFromDir(dir, source)) {
			if (!personaMap.has(persona.name)) personaMap.set(persona.name, persona);
		}
	}

	const personas = Array.from(personaMap.values());
	// Sort with DEFAULT_PERSONA first, then alphabetically by label (what the user sees).
	personas.sort((a, b) =>
		a.name === DEFAULT_PERSONA ? -1 : b.name === DEFAULT_PERSONA ? 1 : a.label.localeCompare(b.label),
	);
	return personas.length > 0 ? personas : [FALLBACK_PERSONA];
}

/**
 * Convenience wrapper: load all personas and find one by name.
 * Callers that already have the list should use .find() instead.
 */
export function findPersona(name: string, options?: LoadPersonasOptions): Persona | undefined {
	return loadPersonas(options).find((p) => p.name === name);
}

/** Backward-compatible convenience: load all personas from all sources. */
export function listPersonas(options?: LoadPersonasOptions): Persona[] {
	return loadPersonas(options);
}
