/**
 * User settings persistence.
 * Saved to ~/.cast/settings.json
 * Loaded on startup, saved after model/reasoning changes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// Settings schema
// ============================================================================

export type PermissionMode = "default" | "bypass";

export interface Settings {
	/** Last used model */
	model?: string;
	/** Last used reasoning level */
	reasoningLevel?: string;
	/** Last used persona name (see personas.ts) — defaults to "coding" when unset. */
	persona?: string;
	/** Last used provider URL */
	providerUrl?: string;
	/** Last used provider API key */
	apiKey?: string;
	/** Last working directory */
	cwd?: string;
	/**
	 * "bypass" skips the confirmation prompt for bash commands that match a
	 * known-dangerous pattern (rm -rf, sudo, force-push, ...). Defaults to
	 * "default" (gated) when unset. Set via `/permissions bypass`, which
	 * requires typing "yes" after a warning first.
	 */
	permissionMode?: PermissionMode;
	/**
	 * Per-project trust decision, keyed by absolute project path. A single
	 * flag gates all project-local resources: skills (.cast/skills/),
	 * MCP servers (.cast/mcp.json), and context files (AGENTS.md,
	 * CLAUDE.md). Asked once per project, remembered in settings.json.
	 * Global resources (~/.cast/) need no trust check.
	 */
	projectTrust?: Record<string, boolean>;
	/** Updated automatically on each run */
	updatedAt?: string;
}

// ============================================================================
// File management
// ============================================================================

const SETTINGS_DIR = ".cast";
const SETTINGS_FILE = "settings.json";

function getSettingsPath(): string {
	return join(process.env.HOME ?? ".", SETTINGS_DIR, SETTINGS_FILE);
}

export function loadSettings(): Settings {
	const path = getSettingsPath();
	if (!existsSync(path)) return {};

	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Settings;
	} catch {
		return {};
	}
}

function saveSettings(settings: Settings): void {
	const dir = join(process.env.HOME ?? ".", SETTINGS_DIR);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	const path = getSettingsPath();
	const merged = { ...settings, updatedAt: new Date().toISOString() };
	writeFileSync(path, JSON.stringify(merged, null, 2), "utf-8");
}

export function updateSettings(partial: Partial<Settings>): void {
	const current = loadSettings();
	saveSettings({ ...current, ...partial });
}

/** true/false if this project's trust decision was already made, undefined if never asked. */
export function getProjectTrust(settings: Settings, projectPath: string): boolean | undefined {
	return settings.projectTrust?.[projectPath];
}

export function setProjectTrust(projectPath: string, trusted: boolean): void {
	const current = loadSettings();
	updateSettings({ projectTrust: { ...current.projectTrust, [projectPath]: trusted } });
}
