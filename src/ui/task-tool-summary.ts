/**
 * Flat-chat summary for the `task` tool — full assignment text, not JSON
 * `key=value` dumps. Pure so it can be unit-tested without mounting Ink.
 */

/** Safety cap so a pathological model arg can't blow the viewport. */
const ASSIGNMENT_CAP = 2000;

/**
 * Format task tool args for the ChatLog row. Returns null when args aren't
 * usable task JSON yet (partial stream) — caller falls back to generic.
 */
export function formatTaskToolSummary(argsJson: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(argsJson);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const obj = parsed as Record<string, unknown>;
	const assignment = typeof obj.assignment === "string" ? obj.assignment.trim() : "";
	if (!assignment) return null;

	const subagent = typeof obj.subagent === "string" ? obj.subagent.trim() : "";
	const capped = assignment.length > ASSIGNMENT_CAP ? `${assignment.slice(0, ASSIGNMENT_CAP)}…` : assignment;
	if (subagent && subagent !== "worker") {
		return `${subagent} · ${capped}`;
	}
	return capped;
}
