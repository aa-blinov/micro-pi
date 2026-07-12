/**
 * Plan mode — restricted agent state for exploring and planning before implementation.
 *
 * The model can read files and produce a structured plan, but cannot execute code,
 * write files, or run shell commands. Plans are persisted as markdown files at
 * ~/.cast/plans/<session-id>/<name>.md — one directory per session, so a session
 * can hold several named plans. The name comes from the model via plan_write and
 * is slugified before hitting the filesystem.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ToolResult } from "./tools.ts";

// ============================================================================
// State
// ============================================================================

/** All plan tool names — used to disable them wherever plan mode can't apply
 * (headless runs, subagents). Within the TUI they split by mode: the authoring
 * tools are plan-mode-only, plan_check/plan_enter are build-mode-only (see App.tsx). */
export const PLAN_TOOL_NAMES = [
	"plan_write",
	"plan_edit",
	"plan_read",
	"plan_done",
	"plan_check",
	"plan_enter",
	"plan_discard",
] as const;

/**
 * Mode policy as data: which tools the TUI hides for a given mode. Plan mode
 * blocks writers (bash stays advertised — the executor gate restricts it to
 * the read-only allowlist) plus the build-only plan tools; build mode blocks
 * the plan-authoring tools. plan_read is deliberately in neither list — it is
 * available in both modes. Kept next to PLAN_TOOL_NAMES so a new plan tool
 * can't be added without deciding its mode here (a test enforces this).
 */
export function modeDisabledTools(planMode: boolean): readonly string[] {
	return planMode
		? ["write", "edit", "plan_check", "plan_enter"]
		: ["plan_write", "plan_edit", "plan_done", "plan_discard"];
}

export interface PlanState {
	enabled: boolean;
	/** Directory holding this session's plans: ~/.cast/plans/<session-id>/ */
	plansDir: string;
	/** Plan most recently written via plan_write in this process. When unset
	 * (e.g. a resumed session), the newest file in plansDir is the active plan. */
	activePlanPath?: string;
}

export function createPlanState(sessionId: string): PlanState {
	// Path only — the directory is created lazily on first write, so merely
	// constructing the state (every App render) touches nothing on disk.
	return { enabled: false, plansDir: join(homedir(), ".cast", "plans", sessionId) };
}

/** Reduce a model-supplied plan name to a safe kebab-case filename stem.
 * Everything outside [a-z0-9] collapses to "-", which also neutralizes path
 * traversal attempts ("../evil" → "evil"). */
export function slugifyPlanName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

// ============================================================================
// Read-only bash gate (plan mode)
// ============================================================================

/** Binaries that only inspect state. Deliberately excludes test runners and
 * package managers (`npm test` runs an arbitrary package.json script), editors
 * (`sed -i`), and anything that can spawn other commands (`xargs`, `awk`). */
const READONLY_BINARIES = new Set([
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"grep",
	"rg",
	"fd",
	"find",
	"file",
	"stat",
	"du",
	"df",
	"tree",
	"diff",
	"sort",
	"uniq",
	"cut",
	"nl",
	"realpath",
	"dirname",
	"basename",
	"which",
	"pwd",
	"echo",
	"printf",
	"date",
	"column",
	"strings",
	"jq",
	"yq",
]);

/** Flags that turn an otherwise read-only binary into a writer or executor.
 * `--output`/`--output=` is checked globally (git log, sort, tree all have
 * output flags); these are the per-binary extras. */
const FORBIDDEN_FLAGS: Record<string, RegExp> = {
	find: /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/,
	fd: /^(-x|-X|--exec|--exec-batch)$/,
	sort: /^(-o|--output)$/,
	tree: /^-o$/,
};

/** Git subcommands that cannot mutate the repository. `branch`/`tag`/`remote`
 * are excluded on purpose — without arguments they list, with arguments they
 * create; `status`/`log` cover the listing use cases. */
const READONLY_GIT_SUBCOMMANDS = new Set([
	"log",
	"show",
	"diff",
	"status",
	"blame",
	"rev-parse",
	"ls-files",
	"ls-tree",
	"ls-remote",
	"shortlog",
	"describe",
	"grep",
	"reflog",
	"cat-file",
	"count-objects",
]);

/**
 * Conservative read-only check for a bash command in plan mode. Allows plain
 * pipelines of inspection binaries; rejects anything that can write: output
 * redirection, command substitution, or a pipeline stage whose binary is not
 * on the allowlist. False negatives (a safe command rejected) are acceptable;
 * false positives (a mutating command allowed) are not.
 */
export function checkReadOnlyCommand(command: string): { ok: boolean; reason?: string } {
	if (/[>]/.test(command)) {
		return { ok: false, reason: "output redirection (>) can write files" };
	}
	if (/\$\(|`|<\(/.test(command)) {
		return { ok: false, reason: "command/process substitution can run arbitrary commands" };
	}
	// Split into pipeline/sequence stages; every stage must be read-only.
	const stages = command
		.split(/\|\||&&|;|\||\n|&/)
		.map((s) => s.trim())
		.filter(Boolean);
	if (stages.length === 0) return { ok: false, reason: "empty command" };
	for (const stage of stages) {
		const tokens = stage.split(/\s+/);
		// Skip leading VAR=value assignments — they only affect the stage env.
		let i = 0;
		while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
		const binary = tokens[i]?.replace(/^.*\//, "");
		if (!binary) return { ok: false, reason: "empty pipeline stage" };
		const args = tokens.slice(i + 1);
		// Output flags write files without any `>` — git log --output, sort -o, …
		if (args.some((t) => t === "--output" || t.startsWith("--output="))) {
			return { ok: false, reason: "--output writes a file" };
		}
		if (binary === "git") {
			const sub = args.find((t) => !t.startsWith("-"));
			if (!sub || !READONLY_GIT_SUBCOMMANDS.has(sub)) {
				return { ok: false, reason: `git ${sub ?? "(none)"} is not a read-only subcommand` };
			}
			continue;
		}
		if (!READONLY_BINARIES.has(binary)) {
			return { ok: false, reason: `"${binary}" is not on the read-only allowlist` };
		}
		const forbidden = FORBIDDEN_FLAGS[binary];
		if (forbidden) {
			const hit = args.find((t) => forbidden.test(t));
			if (hit) return { ok: false, reason: `${binary} ${hit} can modify files or run commands` };
		}
		// `uniq input output` writes its second positional argument.
		if (binary === "uniq" && args.filter((t) => !t.startsWith("-")).length > 1) {
			return { ok: false, reason: "uniq with two file arguments writes the second one" };
		}
	}
	return { ok: true };
}

// ============================================================================
// Plan file I/O
// ============================================================================

function writeFileAtomic(filePath: string, data: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	writeFileSync(tmpPath, data, "utf-8");
	renameSync(tmpPath, filePath);
}

export function readPlanFile(planFilePath: string): {
	exists: boolean;
	content: string;
	headings: string[];
	/** Set when the file exists but could not be read — distinct from "no plan
	 * yet" so callers don't tell the model to overwrite a plan they failed to read. */
	error?: string;
} {
	if (!existsSync(planFilePath)) {
		return { exists: false, content: "", headings: [] };
	}
	try {
		const content = readFileSync(planFilePath, "utf-8").trim();
		if (!content) return { exists: false, content: "", headings: [] };
		const headings = extractHeadings(content);
		return { exists: true, content, headings };
	} catch (err) {
		return {
			exists: false,
			content: "",
			headings: [],
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

function writePlanFile(planFilePath: string, content: string): void {
	writeFileAtomic(planFilePath, content);
}

/** All plan names (filename stems) in a session's plans directory, sorted. */
export function listPlanNames(plansDir: string): string[] {
	try {
		return readdirSync(plansDir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => f.slice(0, -".md".length))
			.sort();
	} catch {
		return [];
	}
}

/** The plan the plan_edit/plan_read/plan_done tools operate on: the one most
 * recently written via plan_write, or — after a resume, when that in-memory
 * marker is gone — the newest .md file in the session's plans directory. */
export function resolveActivePlanPath(planState: PlanState): string | undefined {
	if (planState.activePlanPath && existsSync(planState.activePlanPath)) return planState.activePlanPath;
	try {
		let newest: string | undefined;
		let newestMtime = -1;
		for (const entry of readdirSync(planState.plansDir)) {
			if (!entry.endsWith(".md")) continue;
			const path = join(planState.plansDir, entry);
			const mtime = statSync(path).mtimeMs;
			if (mtime > newestMtime) {
				newestMtime = mtime;
				newest = path;
			}
		}
		return newest;
	} catch {
		return undefined;
	}
}

export function readActivePlan(planState: PlanState): ReturnType<typeof readPlanFile> & { path?: string } {
	const path = resolveActivePlanPath(planState);
	if (!path) return { exists: false, content: "", headings: [] };
	return { ...readPlanFile(path), path };
}

function extractHeadings(content: string): string[] {
	return parseSections(content).map((s) => s.heading);
}

/** True for lines inside ```/~~~ code fences (fence markers included) — a
 * `- [ ]` or `# heading` inside a fenced example is content, not structure.
 * Shared by the section parser and both checklist scanners so they can't
 * drift apart on what counts as a fence. */
function fencedLineMask(lines: string[]): boolean[] {
	const mask: boolean[] = new Array(lines.length);
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*(```|~~~)/.test(lines[i]!)) {
			inFence = !inFence;
			mask[i] = true;
			continue;
		}
		mask[i] = inFence;
	}
	return mask;
}

/** Checklist progress of a plan: counts of unchecked and checked items.
 * Fence-aware — checkbox-like lines inside code blocks don't count. */
export function planChecklistState(content: string): { unchecked: number; checked: number } {
	const lines = content.split("\n");
	const fenced = fencedLineMask(lines);
	let unchecked = 0;
	let checked = 0;
	for (let i = 0; i < lines.length; i++) {
		if (fenced[i]) continue;
		if (/^\s*[-*]\s+\[ \]/.test(lines[i]!)) unchecked++;
		else if (/^\s*[-*]\s+\[x\]/i.test(lines[i]!)) checked++;
	}
	return { unchecked, checked };
}

// ============================================================================
// Plan section extraction (for plan_edit)
// ============================================================================

interface Section {
	heading: string;
	level: number;
	startLine: number;
	bodyStartLine: number;
	bodyEndLine: number;
}

function parseSections(content: string): Section[] {
	const lines = content.split("\n");
	const sections: Section[] = [];

	// Lines inside fenced code blocks are not headings — a `# comment` in a
	// bash snippet must not become a section boundary for plan_edit.
	const fenced = fencedLineMask(lines);
	for (let i = 0; i < lines.length; i++) {
		if (fenced[i]) continue;
		const match = lines[i]!.match(/^(#{1,6})\s+(.+)$/);
		if (match) {
			const level = match[1]!.length;
			const heading = match[2]!.trim();
			sections.push({
				heading,
				level,
				startLine: i,
				bodyStartLine: i + 1,
				bodyEndLine: lines.length, // will be adjusted below
			});
		}
	}

	// Adjust end lines: each section ends where the next same-or-higher-level heading starts
	for (let i = 0; i < sections.length - 1; i++) {
		const current = sections[i]!;
		for (let j = i + 1; j < sections.length; j++) {
			if (sections[j]!.level <= current.level) {
				current.bodyEndLine = sections[j]!.startLine;
				break;
			}
		}
	}

	return sections;
}

// ============================================================================
// Tool executors
// ============================================================================

export function execPlanWrite(args: Record<string, unknown>, planState: PlanState): ToolResult {
	const name = slugifyPlanName(typeof args.name === "string" ? args.name : "");
	if (!name) {
		return {
			content: "Error: name is required — a short descriptive slug like 'auth-refactor'.",
			isError: true,
		};
	}
	const content = typeof args.content === "string" ? args.content.trim() : "";
	if (!content) {
		return { content: "Error: content is required and must not be empty.", isError: true };
	}

	const path = join(planState.plansDir, `${name}.md`);
	writePlanFile(path, content);
	// The plan just written becomes the one plan_edit/plan_read/plan_done target.
	planState.activePlanPath = path;
	return {
		content: JSON.stringify({
			success: true,
			name,
			path,
			charCount: content.length,
		}),
	};
}

export function execPlanEdit(args: Record<string, unknown>, planState: PlanState): ToolResult {
	const heading = typeof args.heading === "string" ? args.heading.trim() : "";
	const newBody = typeof args.content === "string" ? args.content : "";

	if (!heading) {
		return { content: "Error: heading is required.", isError: true };
	}

	const { exists, content, error, path } = readActivePlan(planState);
	if (error) {
		return { content: `Error reading plan file: ${error}`, isError: true };
	}
	if (!exists || !path) {
		return {
			content: `Error: No plan exists yet. Use plan_write to create one first.`,
			isError: true,
		};
	}

	const lines = content.split("\n");
	const sections = parseSections(content);

	// Exact heading match wins over substring, so "Steps" edits "Steps" even
	// when "Next Steps" also exists. Both are case-insensitive.
	const target = heading.toLowerCase();
	let matches = sections.filter((s) => s.heading.toLowerCase() === target);
	if (matches.length === 0) {
		matches = sections.filter((s) => s.heading.toLowerCase().includes(target));
	}
	if (matches.length === 0) {
		return {
			content: JSON.stringify({
				success: false,
				error: `No section heading matches "${heading}".`,
				currentHeadings: sections.map((s) => s.heading),
			}),
			isError: true,
		};
	}
	if (matches.length > 1) {
		return {
			content: JSON.stringify({
				success: false,
				error: `Heading "${heading}" is ambiguous — matches ${matches.length} sections. Use a more specific heading.`,
				matchingHeadings: matches.map((s) => s.heading),
			}),
			isError: true,
		};
	}
	const section = matches[0]!;
	const matchingHeading = section.heading;

	// Replace section body: keep heading line, replace everything until next same-level heading
	const before = lines.slice(0, section.bodyStartLine);
	const after = lines.slice(section.bodyEndLine);
	const newLines = [...before, newBody.trimEnd(), ...after];
	const newContent = newLines.join("\n");

	writePlanFile(path, newContent);

	return {
		content: JSON.stringify({
			success: true,
			plan: basename(path, ".md"),
			section: matchingHeading,
			charCount: newContent.length,
		}),
	};
}

export function execPlanRead(args: Record<string, unknown>, planState: PlanState): ToolResult {
	// Optional name: read a specific plan and make it the active one — this is
	// how the model switches between several plans without rewriting them.
	const requested = typeof args.name === "string" && args.name.trim() ? slugifyPlanName(args.name) : undefined;
	let result: ReturnType<typeof readActivePlan>;
	if (requested) {
		const path = join(planState.plansDir, `${requested}.md`);
		if (!existsSync(path)) {
			return {
				content: JSON.stringify({
					success: false,
					error: `No plan named "${requested}" in this session.`,
					plans: listPlanNames(planState.plansDir),
				}),
				isError: true,
			};
		}
		result = { ...readPlanFile(path), path };
	} else {
		result = readActivePlan(planState);
	}

	const { exists, content, headings, error, path } = result;
	if (error) {
		return { content: `Error reading plan file: ${error}`, isError: true };
	}
	if (!exists || !path) {
		return { content: JSON.stringify({ exists: false, plans: listPlanNames(planState.plansDir) }) };
	}
	// In plan mode the plan just read becomes the target of plan_edit/plan_done.
	// In build mode reading is reference-only: the approved plan keeps steering
	// the implementation (mirror block + plan_check default) — swapping it mid-
	// build would bypass the /build approval.
	if (planState.enabled) {
		planState.activePlanPath = path;
	}
	return {
		content: JSON.stringify({
			exists: true,
			name: basename(path, ".md"),
			content,
			headings,
			charCount: content.length,
			// Other plans in this session — plan_read with one of these names
			// switches to that plan; plan_write with one replaces it.
			plans: listPlanNames(planState.plansDir),
		}),
	};
}

export function execPlanCheck(args: Record<string, unknown>, planState: PlanState): ToolResult {
	const item = typeof args.item === "string" ? args.item.trim() : "";
	if (!item) {
		return { content: "Error: item is required — the text of the checklist entry to mark done.", isError: true };
	}

	// Optional plan name — a session can hold several plans; default is the active one.
	const requested = typeof args.plan === "string" && args.plan.trim() ? slugifyPlanName(args.plan) : undefined;
	let targetPlan: ReturnType<typeof readActivePlan>;
	if (requested) {
		const planPath = join(planState.plansDir, `${requested}.md`);
		if (!existsSync(planPath)) {
			return {
				content: JSON.stringify({
					success: false,
					error: `No plan named "${requested}" in this session.`,
					plans: listPlanNames(planState.plansDir),
				}),
				isError: true,
			};
		}
		targetPlan = { ...readPlanFile(planPath), path: planPath };
	} else {
		targetPlan = readActivePlan(planState);
	}

	const { exists, content, error, path } = targetPlan;
	if (error) {
		return { content: `Error reading plan file: ${error}`, isError: true };
	}
	if (!exists || !path) {
		return { content: "Error: No plan exists for this session.", isError: true };
	}

	const lines = content.split("\n");
	const checkboxRe = /^(\s*[-*]\s+)\[ \]\s*(.*)$/;
	// Fence-aware: a checkbox-like line inside a code example is content, not
	// a step — matching it would corrupt the example.
	const fenced = fencedLineMask(lines);
	const unchecked = lines
		.map((line, index) => {
			if (fenced[index]) return undefined;
			const match = line.match(checkboxRe);
			return match ? { index, prefix: match[1]!, text: match[2]!.trim() } : undefined;
		})
		.filter((c) => c !== undefined);

	if (unchecked.length === 0) {
		return { content: "Error: The plan has no unchecked checklist items.", isError: true };
	}

	// Same matching contract as plan_edit: case-insensitive, exact wins over substring.
	const target = item.toLowerCase();
	let matches = unchecked.filter((c) => c.text.toLowerCase() === target);
	if (matches.length === 0) {
		matches = unchecked.filter((c) => c.text.toLowerCase().includes(target));
	}
	if (matches.length === 0) {
		return {
			content: JSON.stringify({
				success: false,
				error: `No unchecked item matches "${item}".`,
				uncheckedItems: unchecked.map((c) => c.text),
			}),
			isError: true,
		};
	}
	if (matches.length > 1) {
		return {
			content: JSON.stringify({
				success: false,
				error: `Item "${item}" is ambiguous — matches ${matches.length} entries. Use more specific text.`,
				matchingItems: matches.map((c) => c.text),
			}),
			isError: true,
		};
	}

	const checked = matches[0]!;
	lines[checked.index] = `${checked.prefix}[x] ${checked.text}`;
	writePlanFile(path, lines.join("\n"));

	const remaining = unchecked.length - 1;
	return {
		content: JSON.stringify({
			success: true,
			plan: basename(path, ".md"),
			item: checked.text,
			remaining,
			...(remaining === 0 ? { allDone: true } : {}),
		}),
	};
}

export function execPlanDiscard(args: Record<string, unknown>, planState: PlanState): ToolResult {
	const name = slugifyPlanName(typeof args.name === "string" ? args.name : "");
	if (!name) {
		return { content: "Error: name is required — the plan to discard.", isError: true };
	}
	const path = join(planState.plansDir, `${name}.md`);
	if (!existsSync(path)) {
		return {
			content: JSON.stringify({
				success: false,
				error: `No plan named "${name}" in this session.`,
				plans: listPlanNames(planState.plansDir),
			}),
			isError: true,
		};
	}
	try {
		unlinkSync(path);
	} catch (err) {
		return {
			content: `Error deleting plan file: ${err instanceof Error ? err.message : String(err)}`,
			isError: true,
		};
	}
	// If the discarded plan was active, fall back to the newest remaining one.
	if (planState.activePlanPath === path) planState.activePlanPath = undefined;
	const remaining = listPlanNames(planState.plansDir);
	const activePath = resolveActivePlanPath(planState);
	return {
		content: JSON.stringify({
			success: true,
			discarded: name,
			plans: remaining,
			active: activePath ? basename(activePath, ".md") : null,
		}),
	};
}

export function execPlanEnter(args: Record<string, unknown>, _planState: PlanState): ToolResult {
	const reason = typeof args.reason === "string" ? args.reason.trim() : "";
	if (!reason) {
		return {
			content: "Error: reason is required — one sentence on why this task benefits from planning first.",
			isError: true,
		};
	}
	// Pure signal: the UI shows a confirmation dialog when the turn ends and
	// switches the mode itself if the user agrees. The tool can't block on the
	// user mid-run, so the contract is "call it, then end your turn".
	return {
		content: JSON.stringify({
			planSuggested: true,
			reason,
			note: "The user will be asked to confirm. End your turn now and wait for their decision.",
		}),
	};
}

export function execPlanDone(args: Record<string, unknown>, planState: PlanState): ToolResult {
	const summary = typeof args.summary === "string" ? args.summary.trim() : "";
	const { exists, content, error, path } = readActivePlan(planState);

	if (error) {
		return { content: `Error reading plan file: ${error}`, isError: true };
	}
	if (!exists || !path) {
		return {
			content: "Error: No plan exists. Write a plan first using plan_write.",
			isError: true,
		};
	}

	// Return the plan content + signal that it's ready for review. The UI
	// shows a "[Plan ready — /build to implement]" message on this tool's
	// success; switching modes stays a user decision (/build), never automatic.
	return {
		content: JSON.stringify({
			planReady: true,
			name: basename(path, ".md"),
			summary: summary || "Plan complete",
			content,
			path,
		}),
	};
}
