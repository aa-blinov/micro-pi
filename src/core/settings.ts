/**
 * User settings persistence.
 * Saved to ~/.cast/settings.json
 * Loaded on startup, saved after model/reasoning changes.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Settings schema
// ============================================================================

export type PermissionMode = "default" | "bypass";

export interface StatusBarConfig {
	visible: string[];
	order: string[];
	sides: Record<string, "left" | "right">;
}

export interface Provider {
	name: string;
	url: string;
	apiKey: string;
}

export interface Settings {
	/** Last used model */
	model?: string;
	/** Provider name for the main model (falls back to active provider if unset). */
	modelProvider?: string;
	/** Model used for subagents (falls back to model if unset). */
	subagentModel?: string;
	/** Provider name for the subagent model (falls back to active provider if unset). */
	subagentModelProvider?: string;
	/** Model used while plan mode is active (falls back to model if unset) —
	 * lets planning run on a stronger model than day-to-day building. */
	planModel?: string;
	/** Provider name for the plan model (falls back to active provider if unset). */
	planModelProvider?: string;
	/** Last used reasoning level */
	reasoningLevel?: string;
	/** Last used persona name (see personas.ts) — defaults to "coding" when unset. */
	persona?: string;
	/** Last used provider URL */
	providerUrl?: string;
	/** Last used provider API key */
	apiKey?: string;
	/** Saved providers for quick switching via /provider. */
	providers?: Provider[];
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
	/** Active color theme id (see src/ui/themes/registry.ts). */
	theme?: string;
	/** When false, web_search and web_fetch tools are not advertised to the model. */
	webTools?: boolean;
	/** MCP server names the user has disabled via /mcp toggle. Persisted so
	 * they stay disabled across sessions and /reload. */
	disabledMcpServers?: string[];
	/** Skill names disabled via /skills toggle. Still discovered for the picker;
	 * omitted from the agent catalog and /skill: invocation until re-enabled. */
	disabledSkills?: string[];
	/**
	 * Installed marketplace plugins keyed by `name@marketplace`.
	 * `true`/absent-after-install = enabled; `false` = installed but disabled.
	 * Package lives under ~/.cast/plugins/; see plugins.ts.
	 */
	enabledPlugins?: Record<string, boolean>;
	/** Status bar segment configuration: which are visible, order, and sides. */
	statusBar?: StatusBarConfig;
	/** @deprecated Agent mode moved to SessionState.mode — the mode is per-task
	 * session state, and storing it globally leaked plan mode across projects.
	 * Kept only so old settings.json files still parse. */
	mode?: "plan" | "build";
	/** Web UI password — auto-generated on first `cast web` run. */
	webPassword?: string;
}

// ============================================================================
// File management
// ============================================================================

const SETTINGS_DIR = ".cast";
const SETTINGS_FILE = "settings.json";

function getSettingsPath(): string {
	return join(homedir(), SETTINGS_DIR, SETTINGS_FILE);
}

export function loadSettings(): Settings {
	const path = getSettingsPath();
	if (!existsSync(path)) return {};

	try {
		const s = JSON.parse(readFileSync(path, "utf-8")) as Settings;
		return migrateProviders(s);
	} catch {
		return {};
	}
}

/**
 * One-time migration: if `providers` is missing/empty but `providerUrl` +
 * `apiKey` exist (legacy single-provider settings), populate `providers`
 * so `/provider` can list and switch from the start.
 */
function migrateProviders(s: Settings): Settings {
	if (s.providers?.length) return s;
	if (s.providerUrl && s.apiKey) {
		return { ...s, providers: [{ name: "default", url: s.providerUrl, apiKey: s.apiKey }] };
	}
	return s;
}

function saveSettings(settings: Settings): void {
	const dir = join(homedir(), SETTINGS_DIR);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	const path = getSettingsPath();
	const merged = { ...settings, updatedAt: new Date().toISOString() };
	// Write to a temp file then rename over the target — rename is atomic within
	// a filesystem, so a crash mid-write can't truncate settings.json (loadSettings
	// falls back to {} on a parse error, silently losing the user's config).
	const tmpPath = `${path}.${process.pid}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
	renameSync(tmpPath, path);
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
