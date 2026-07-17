/**
 * Turn-end open-work gate: when the model stops without tool calls while the
 * active plan still has open steps, inject a `<system-reminder>` and continue
 * sampling (capped per user prompt).
 *
 * Open work is read from the plan on disk via `listOpenPlanSteps` — checklist
 * `- [ ]` items, or `###` headings under `## Steps` when there is no checklist.
 */

import type { PlanState } from "./plan.ts";
import { listOpenPlanSteps, readActivePlan } from "./plan.ts";

/** Default cap on how many times the gate may force-continue per user prompt. */
export const DEFAULT_OPEN_WORK_GATE_MAX_FIRES = 2;

export interface OpenWorkGateConfig {
	/** When false, the gate never runs. Default true (subject to `isOpenWorkGateActive`). */
	enabled: boolean;
	/** Hard cap on nudge fires before fallthrough. */
	maxFiresPerPrompt: number;
}

export function defaultOpenWorkGateConfig(): OpenWorkGateConfig {
	return {
		enabled: true,
		maxFiresPerPrompt: DEFAULT_OPEN_WORK_GATE_MAX_FIRES,
	};
}

export interface OpenWorkGateInput {
	openSteps: string[];
}

export type OpenWorkGateDecision = { type: "continue" } | { type: "nudge"; reminder: string };

/** Pure decision — cap logic stays in the loop caller. */
export function evaluateOpenWorkGate(input: OpenWorkGateInput): OpenWorkGateDecision {
	if (input.openSteps.length === 0) return { type: "continue" };
	return { type: "nudge", reminder: buildOpenWorkGateReminder(input.openSteps) };
}

export function buildOpenWorkGateReminder(openSteps: string[]): string {
	const lines = openSteps.map((s) => `- ${s}`).join("\n");
	const body = [
		"You have outstanding plan steps but ended your turn without a tool call.",
		"",
		"Pending:",
		lines,
		"",
		"Advance the next open step with the appropriate tool call now. If you have a genuine external blocker, state it explicitly in this turn. Use plan_check to mark checklist items done only after the work is finished; do not stop while open steps remain.",
	].join("\n");
	return wrapSystemReminder(body);
}

export function buildOpenWorkGateExhaustedReminder(maxFires: number): string {
	const body =
		`The agent attempted to end this turn ${maxFires} times with plan steps still open. ` +
		`Falling through to the user. Prompt the agent to continue explicitly, or update/clear the plan.`;
	return wrapSystemReminder(body);
}

function wrapSystemReminder(body: string): string {
	return `<system-reminder>\n${body}\n</system-reminder>`;
}

/**
 * Whether the gate should run for this loop config.
 * Build mode + planState + an active plan file on disk.
 */
export function isOpenWorkGateActive(planState: PlanState | undefined, config: OpenWorkGateConfig): boolean {
	if (!config.enabled) return false;
	if (!planState || planState.enabled) return false;
	const plan = readActivePlan(planState);
	return plan.exists && Boolean(plan.path);
}

/** Fresh open steps from disk for the active plan (empty when inactive / missing). */
export function collectOpenWorkSteps(planState: PlanState | undefined): string[] {
	if (!planState || planState.enabled) return [];
	const plan = readActivePlan(planState);
	if (!plan.exists) return [];
	return listOpenPlanSteps(plan.content);
}
