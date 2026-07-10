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

import { readFileSync } from "node:fs";
import { join } from "node:path";

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
