/**
 * Post-compaction state reminder — matches grok-build's shape:
 * a separate `<system-reminder>` message after the summary, omitted when
 * there is nothing actionable to preserve.
 *
 * Shared grok sections we map onto cast state:
 * - Files Edited This Session ← modified file tags
 * - TODO List ← open plan steps (`- [ ]`, or `###` under `## Steps`)
 *
 * Cast harness-only: plan/build mode line (grok has no plan mode).
 */

import { basename } from "node:path";
import type { Message } from "./llm.ts";
import { listOpenPlanSteps, type PlanState, readActivePlan } from "./plan.ts";

const MAX_OPEN_STEPS = 8;
const MAX_FILES = 12;

export interface PostCompactReminderState {
	/** Active agent mode, if known. */
	mode?: "plan" | "build";
	/** Active plan basename without `.md`. */
	planName?: string;
	/** Open step texts (`- [ ]` body, or `###` heading under Steps). */
	openSteps?: string[];
	/** Total open count when `openSteps` is truncated. */
	openStepsTotal?: number;
	readFiles?: string[];
	modifiedFiles?: string[];
}

/** Snapshot plan/mode fields for a post-compact reminder. */
export function reminderStateFromPlan(planState: PlanState | undefined): PostCompactReminderState {
	if (!planState) return {};
	if (planState.enabled) return { mode: "plan" };

	const plan = readActivePlan(planState);
	if (!plan.exists || !plan.path) return { mode: "build" };

	const planName = basename(plan.path, ".md");
	const openSteps = listOpenPlanSteps(plan.content);
	if (openSteps.length === 0) return { mode: "build", planName };

	return {
		mode: "build",
		planName,
		openSteps: openSteps.slice(0, MAX_OPEN_STEPS),
		openStepsTotal: openSteps.length,
	};
}

function formatEditedFiles(files: string[] | undefined): string | undefined {
	if (!files || files.length === 0) return undefined;
	const shown = files.slice(0, MAX_FILES);
	const extra = files.length - shown.length;
	const body = shown.map((f) => `- ${f}`).join("\n");
	const trailer = extra > 0 ? `\n(${extra} more)` : "";
	return `## Files Edited This Session\nThese files were modified by you during this session:\n${body}${trailer}`;
}

function formatTodoList(
	openSteps: string[] | undefined,
	openStepsTotal: number | undefined,
	planName: string | undefined,
): string | undefined {
	if (!openSteps || openSteps.length === 0) return undefined;
	const total = openStepsTotal ?? openSteps.length;
	const lines = openSteps.map((s) => `- [pending] ${s}`).join("\n");
	const remaining = total - openSteps.length;
	const trailer = remaining > 0 ? `\n(${remaining} more)` : "";
	const planBit = planName ? ` (plan \`${planName}\`)` : "";
	return (
		`## TODO List\n` +
		`This is your task list from before the conversation was compacted${planBit} — it is still ` +
		`active. Keep working through the items below and update their status as you make progress:\n` +
		`${lines}${trailer}`
	);
}

/**
 * Format the `<system-reminder>` block, or `undefined` when nothing actionable
 * (same omit-when-empty rule as grok-build's `wrap_system_reminder`).
 */
export function formatPostCompactReminder(state: PostCompactReminderState = {}): string | undefined {
	const sections: string[] = [];

	// Cast harness-only — grok has no plan/build mode.
	if (state.mode === "plan") {
		sections.push(
			"## Mode\nplan mode is active — explore and author the plan; do not implement (no write/edit; bash is inspection-only).",
		);
	} else if (state.mode === "build" && state.planName) {
		sections.push(`## Mode\nbuild mode. Active plan: \`${state.planName}\`.`);
	}

	const edited = formatEditedFiles(state.modifiedFiles);
	if (edited) sections.push(edited);

	const todos = formatTodoList(state.openSteps, state.openStepsTotal, state.planName);
	if (todos) sections.push(todos);

	if (sections.length === 0) return undefined;
	return `<system-reminder>\n${sections.join("\n\n")}\n</system-reminder>`;
}

/**
 * Inject the reminder as its own trailing user message — grok-build's
 * assemble order ends with `[…, summary, reminder?]`, and the shell test
 * asserts the reminder is a separate message that must NOT be inside the
 * summary text.
 */
export function injectPostCompactReminder(messages: Message[], reminder: string | undefined): void {
	if (!reminder?.trim()) return;
	messages.push({ role: "user", content: reminder });
}
