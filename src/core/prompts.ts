/**
 * Shared helper for reading required prompt files that ship in prompts/.
 *
 * Unlike the optional prompts in personas.ts (error-handling.md,
 * fallback-persona.md), these files are load-bearing: compaction can't run
 * without its prompts, and the rules/skills instructions frame how the model
 * uses those features. A missing file means the install is broken, so we fail
 * with a clear, actionable message instead of letting a raw ENOENT from a
 * module-level readFileSync crash the whole CLI before it even starts.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to the shipped `prompts/` directory.
 *
 * The bundle (dist/index.js) sits one level below the install root where
 * prompts/ lives; source files (src/core/*.ts) sit two levels below the repo
 * root. This module is under src/core/ (and bundled into dist/), so the same
 * two-candidate probe every prompt-reading module used to duplicate resolves
 * correctly from here for both layouts.
 */
const _selfDir = dirname(fileURLToPath(import.meta.url));
export const promptsDir = existsSync(join(_selfDir, "..", "prompts"))
	? join(_selfDir, "..", "prompts")
	: join(_selfDir, "..", "..", "prompts");

/** Read a required prompt file, throwing a clear error if it's missing. */
export function readRequiredPrompt(promptsDir: string, fileName: string): string {
	try {
		return readFileSync(join(promptsDir, fileName), "utf-8").trim();
	} catch (err) {
		throw new Error(
			`cast: could not read required prompt file "${fileName}" from ${promptsDir}. ` +
				`This usually means the installation is incomplete — try reinstalling cast. ` +
				`(${err instanceof Error ? err.message : String(err)})`,
		);
	}
}

/**
 * Optional shared sections appended to every persona and subagent prompt:
 * tool-failure mechanics, the read/edit/hashline contract, and turn discipline
 * (safety / parallel / preamble / secrecy). Missing files omit that section
 * rather than failing the whole load — same policy as the previous private
 * helpers in personas.ts.
 */
function readOptionalShared(fileName: string): string {
	try {
		return readFileSync(join(promptsDir, fileName), "utf-8").trim();
	} catch {
		return "";
	}
}

/** Append error-handling + file-tool + agent-discipline guidance after a role prompt body. */
export function withSharedToolPrompt(body: string): string {
	return [
		body.trimEnd(),
		readOptionalShared("error-handling.md"),
		readOptionalShared("tools-edit.md"),
		readOptionalShared("harness-discipline.md"),
	]
		.filter(Boolean)
		.join("\n\n");
}
