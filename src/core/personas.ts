/**
 * Personas — swappable system prompts that give the agent a different role
 * (coding agent, fiction writer, ...) without touching the tool set. The
 * tools (bash/read/write/edit/find/grep/ls) are generic file/shell
 * primitives already, not code-specific in themselves — the persona is
 * entirely a matter of which instructions frame how they're used.
 *
 * Shipped personas live in prompts/personas/*.md as frontmatter + body,
 * same shape as a skill: name, label, description. Unlike skills, these
 * ship with cast itself (not user-provided), so there's no trust gate —
 * and there's no "always inject the description" step either, since only
 * one persona is active at a time and its full body becomes the system
 * prompt directly. prompts/error-handling.md is appended to every persona
 * (see readSharedErrorHandling below).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./frontmatter.ts";

export interface Persona {
	name: string;
	label: string;
	description: string;
	systemPrompt: string;
}

export const DEFAULT_PERSONA = "coding";

const _selfDir = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = existsSync(join(_selfDir, "..", "prompts"))
	? join(_selfDir, "..", "prompts")
	: join(_selfDir, "..", "..", "prompts");

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
	systemPrompt: [readFallbackPersonaPrompt(), readSharedErrorHandling()].filter(Boolean).join("\n\n"),
};

function personasDir(): string {
	return join(PROMPTS_DIR, "personas");
}

function loadPersonaFromFile(filePath: string): Persona | null {
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
		systemPrompt: [body.trimEnd(), readSharedErrorHandling()].filter(Boolean).join("\n\n"),
	};
}

/** All personas shipped in prompts/personas/. Falls back to a single generic persona if that's missing. */
export function listPersonas(): Persona[] {
	let files: string[];
	try {
		files = readdirSync(personasDir()).filter((f) => f.endsWith(".md"));
	} catch {
		return [FALLBACK_PERSONA];
	}

	const personas = files
		.map((f) => loadPersonaFromFile(join(personasDir(), f)))
		.filter((p): p is Persona => p !== null)
		.sort((a, b) =>
			a.name === DEFAULT_PERSONA ? -1 : b.name === DEFAULT_PERSONA ? 1 : a.name.localeCompare(b.name),
		);

	return personas.length > 0 ? personas : [FALLBACK_PERSONA];
}

export function findPersona(name: string): Persona | undefined {
	return listPersonas().find((p) => p.name === name);
}
