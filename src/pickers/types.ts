import type { PermissionMode } from "../core/settings.ts";
import type { ModelReasoningMeta } from "../core/vendors.ts";

export interface PickOption<T> {
	value: T;
	label: string;
	description?: string;
}

export interface PickOptions {
	title?: string;
	defaultIndex?: number;
}

/**
 * UI-agnostic picker surface. Both the readline CLI and the Ink TUI implement
 * this same interface — the domain functions in `domain.ts` call these methods
 * and never know whether a list was rendered as a numbered prompt or a
 * scrollable menu. Either method resolving to `null` means "user cancelled"
 * (Esc in the TUI, empty Enter in readline) — the domain layer decides what
 * that means (usually exit, since onboarding has no sensible no-op).
 */
export interface Pickers {
	pickOption<T>(options: PickOption<T>[], opts?: PickOptions): Promise<T | null>;
	promptText(label: string, defaultValue?: string, placeholder?: string): Promise<string | null>;
	/**
	 * One-off status text (connection checks, trust prompts, etc.) — readline
	 * just `console.log`s it; the TUI routes it through the same notice line
	 * used elsewhere instead of writing straight to stdout, which would
	 * corrupt Ink's managed frame (raw writes and Ink's own redraw fight over
	 * the same terminal rows).
	 */
	log(text: string): void;
}

export interface ModelSelection {
	model: string;
	reasoningMeta?: ModelReasoningMeta;
	contextWindow?: number;
}

export const PERMISSION_MODES: Array<{ value: PermissionMode; label: string }> = [
	{
		value: "default",
		label: "default — bash commands matching a dangerous pattern (rm -rf, sudo, force-push, ...) ask first",
	},
	{ value: "bypass", label: "bypass  — no confirmation for any bash command, including destructive ones" },
];
