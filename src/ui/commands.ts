import { execFileSync, execSync } from "node:child_process";
import { homedir } from "node:os";
import { reminderStateFromPlan } from "../core/compaction-reminder.ts";
import { type AppConfig, probeProvider, runOnboardingCheck } from "../core/config.ts";
import { formatContextFilesForPrompt, loadProjectContextFiles } from "../core/context-files.ts";
import { compactSessionMessages, PLAN_COMPACTION_PROMPT } from "../core/loop.ts";
import { closeMcpConnections, formatMcpForPrompt, type McpSetupResult, mcpServerToolBlurbs } from "../core/mcp.ts";
import { findPersona, type LoadPersonasOptions, type Persona } from "../core/personas.ts";
import { createPlanState, readActivePlan } from "../core/plan.ts";
import {
	addMarketplace,
	ensureDefaultMarketplaces,
	getMarketplaceCatalog,
	installPlugin,
	listInstalledPlugins,
	listKnownMarketplaces,
	parsePluginRef,
	removeMarketplace,
	setPluginEnabled,
	uninstallPlugin,
	updateMarketplace,
} from "../core/plugins.ts";
import {
	buildSystemPrompt,
	discoverSkillsForCwd,
	listUninstallableMcpServers,
	type ProjectResolverDeps,
	personaOptionsForCwd,
	removeMcpServerFromDisk,
	resolveMcpForCwd,
	resolveProjectTrustForCwd,
	resolveRulesForCwd,
	resolveSkillsForCwd,
} from "../core/project.ts";
import { getModelsCache } from "../core/readline.ts";
import { formatRuleInvocation, type Rule } from "../core/rules.ts";
import { addUsage, createSession, type SessionState, saveSession } from "../core/session.ts";
import {
	loadSettings,
	type PermissionMode,
	type Provider,
	type StatusBarConfig,
	updateSettings,
} from "../core/settings.ts";
import { formatSkillInvocation, isUninstallableSkill, type Skill, uninstallUserSkill } from "../core/skills.ts";
import { type SshHost, saveSshConfig, scanSshKeys, validateKeyPermissions } from "../core/ssh.ts";
import { getReasoningOptions, type ModelReasoningMeta } from "../core/vendors.ts";
import {
	formatSkillPickLabel,
	selectMcpServers,
	selectModel,
	selectPermissionMode,
	selectPersona,
	selectPlugins,
	selectReasoningLevel,
	selectSession,
	selectSkills,
} from "../pickers/domain.ts";
import type { Pickers, PickOption } from "../pickers/types.ts";
import { abbreviateTokens } from "./App.tsx";
import { TUI_KEYBINDINGS } from "./input/keybindings.ts";
import { getStatusBarSegments, SEGMENT_MAX_WIDTH, type SegmentContext, type StatusBarSegment } from "./statusbar.tsx";
import { ALL_THEMES, getActiveTheme, setActiveTheme } from "./themes/index.ts";
import type { PendingImage, UseAgentSession } from "./useAgentSession.ts";

/**
 * Slash commands shown in the Composer's autocomplete palette.
 *
 * `takesArgs` marks the commands that need an argument *typed inline* after the
 * name — picking those from the palette fills the name and waits for input.
 * Every other command runs standalone or opens its own picker, so the palette
 * runs it immediately on Enter instead of making the user confirm with a second
 * keystroke (see Composer's selectCommand).
 */
// Rendered verbatim by the composer's command palette — keep alphabetical by
// name (enforced by a test) so the list is scannable as it grows.
export const SLASH_COMMANDS: Array<{ name: string; description: string; takesArgs?: boolean }> = [
	{ name: "/abort", description: "Abort the current run" },
	{ name: "/build", description: "Exit plan mode, restore full toolset" },
	{ name: "/clear", description: "Clear context (and save)" },
	{ name: "/compact", description: "Compact context now" },
	{ name: "/copy", description: "Copy last assistant response" },
	{ name: "/current", description: "Show all status bar data" },
	{ name: "/exit", description: "Save and exit (alias for /quit)" },
	{ name: "/help", description: "Show this command list" },
	{ name: "/keys", description: "List all keybindings" },
	{ name: "/mcp", description: "Toggle MCP servers on/off" },
	{ name: "/mcp disable", description: "Disable one server — name", takesArgs: true },
	{ name: "/mcp enable", description: "Enable one server — name", takesArgs: true },
	{ name: "/mcp help", description: "Show MCP command cheat sheet" },
	{ name: "/mcp list", description: "List configured MCP servers" },
	{
		name: "/mcp uninstall",
		description: "Uninstall — picker, or server name",
		takesArgs: true,
	},
	{ name: "/model", description: "Show or change model" },
	{ name: "/new", description: "Start a new session" },
	{ name: "/permissions", description: "Change bash confirmation mode" },
	{ name: "/persona", description: "Show or change persona" },
	{ name: "/plan", description: "Enter plan mode (explore + plan only)" },
	{ name: "/plan-model", description: "Show or change the plan-mode model" },
	// /plugin* — separate palette rows so typing "/plugin" shows the full menu
	// (Composer matches name.startsWith; space closes the palette after pick).
	{ name: "/plugin", description: "Toggle installed plugins on/off" },
	{ name: "/plugin disable", description: "Disable one plugin — name@marketplace", takesArgs: true },
	{ name: "/plugin enable", description: "Enable one plugin — name@marketplace", takesArgs: true },
	{ name: "/plugin help", description: "Show plugin command cheat sheet" },
	{
		name: "/plugin install",
		description: "Install — name@marketplace (e.g. superpowers@xai-official)",
		takesArgs: true,
	},
	{ name: "/plugin list", description: "List installed plugins" },
	{ name: "/plugin marketplace add", description: "Add catalog — owner/repo, URL, or path", takesArgs: true },
	{
		name: "/plugin marketplace list",
		description: "List catalogs, or plugins in one — optional name",
		takesArgs: true,
	},
	{ name: "/plugin marketplace remove", description: "Remove a catalog — name", takesArgs: true },
	{ name: "/plugin marketplace update", description: "Refresh a catalog — name", takesArgs: true },
	{
		name: "/plugin uninstall",
		description: "Uninstall — picker, or name@marketplace",
		takesArgs: true,
	},
	{ name: "/provider", description: "Switch / add / delete providers" },
	{ name: "/q", description: "Alias for /queue", takesArgs: true },
	{ name: "/qr", description: "Alias for /queue-reset" },
	{ name: "/queue", description: "Queue a message for after the run", takesArgs: true },
	{ name: "/queue-reset", description: "Clear the message queue" },
	{ name: "/quit", description: "Save and exit" },
	{ name: "/reasoning", description: "Change reasoning level" },
	{ name: "/reload", description: "Reload skills, rules, MCP, and personas for cwd" },
	{ name: "/repo", description: "Show cwd and git branch" },
	{ name: "/rule:", description: "Invoke a rule by name", takesArgs: true },
	{ name: "/rules", description: "List loaded rules" },
	{ name: "/s", description: "Alias for /steer", takesArgs: true },
	{ name: "/sessions", description: "List / switch / delete sessions" },
	{ name: "/skills", description: "Toggle skills on/off" },
	{ name: "/skills disable", description: "Disable one skill — name", takesArgs: true },
	{ name: "/skills enable", description: "Enable one skill — name", takesArgs: true },
	{ name: "/skills help", description: "Show skills command cheat sheet" },
	{ name: "/skills list", description: "List loaded skills" },
	{
		name: "/skills uninstall",
		description: "Uninstall — picker, or skill name (cast/agents dirs)",
		takesArgs: true,
	},
	{ name: "/ssh", description: "Manage SSH hosts (list, add, remove)" },
	{ name: "/statusbar", description: "Toggle and reorder status bar segments" },
	{ name: "/steer", description: "Inject a message while running", takesArgs: true },
	{ name: "/subagent-model", description: "Show or change subagent model" },
	{ name: "/theme", description: "Change color theme" },
	{ name: "/usage", description: "Show session token and cost usage" },
	{ name: "/web", description: "Toggle web tools (web_search, web_fetch)" },
];

export interface CommandDeps {
	agent: UseAgentSession;
	session: SessionState;
	config: AppConfig;
	running: boolean;
	onQuit: () => void;
	showNotice: (text: string, duration?: number) => void;
	cwd: string;
	setCwd: (cwd: string) => void;
	currentPersona: Persona;
	setCurrentPersona: (p: Persona) => void;
	personaOptions: LoadPersonasOptions;
	setPersonaOptions: (o: LoadPersonasOptions) => void;
	skills: Skill[];
	setSkills: (s: Skill[]) => void;
	skillsPromptSuffix: string;
	setSkillsPromptSuffix: (s: string) => void;
	contextFilesSuffix: string;
	setContextFilesSuffix: (s: string) => void;
	rulesSuffix: string;
	setRulesSuffix: (s: string) => void;
	rulesLazySuffix: string;
	setRulesLazySuffix: (s: string) => void;
	directoryRules: Rule[];
	setDirectoryRules: (r: Rule[]) => void;
	activeAutoRules: Rule[];
	setActiveAutoRules: (r: Rule[]) => void;
	systemPrompt: string;
	setSystemPrompt: (s: string) => void;
	mcpResult: McpSetupResult;
	setMcpResult: (m: McpSetupResult) => void;
	permissionMode: PermissionMode;
	setPermissionMode: (m: PermissionMode) => void;
	projectTrusted: boolean;
	setProjectTrusted: (t: boolean) => void;
	projectDeps: ProjectResolverDeps;
	pickers: Pickers;
	sshHosts: SshHost[];
	setSshHosts: (hosts: SshHost[]) => void;
	reasoningMeta: ModelReasoningMeta | undefined;
	setReasoningMeta: (m: ModelReasoningMeta | undefined) => void;
	subagentModel?: string;
	setSubagentModel: (m: string | undefined) => void;
	webToolsEnabled: boolean;
	setWebToolsEnabled: (v: boolean) => void;
	planMode: boolean;
	setPlanMode: (v: boolean) => void;
	/** Model used while plan mode is active; undefined falls back to session.model. */
	planModel?: string;
	setPlanModel: (m: string | undefined) => void;
	onThemeChange?: () => void;
	statusBar: StatusBarConfig;
	setStatusBar: (s: StatusBarConfig) => void;
}

/**
 * Helper: rebuild system prompt and push it. Takes explicit overrides rather
 * than reading `deps.currentPersona`/`deps.rulesSuffix`/etc. back — those come
 * from a `deps` object built once per `handleInput` call from that render's
 * state, so a `setCurrentPersona(x)` a few lines above doesn't change what
 * `deps.currentPersona` reads for the rest of *this* call (state updates
 * apply on the next render, not synchronously). Reading them back here used
 * to rebuild the prompt from the value being replaced, so e.g. /persona took
 * a full extra round-trip to actually change what the model saw.
 */
function rebuildSystemPrompt(
	deps: CommandDeps,
	cwd: string,
	overrides: {
		persona?: Persona;
		contextFilesSuffix?: string;
		rulesSuffix?: string;
		rulesLazySuffix?: string;
		skillsPromptSuffix?: string;
	} = {},
): void {
	deps.setSystemPrompt(
		buildSystemPrompt(
			overrides.persona ?? deps.currentPersona,
			overrides.contextFilesSuffix ?? deps.contextFilesSuffix,
			overrides.rulesSuffix ?? deps.rulesSuffix,
			overrides.rulesLazySuffix ?? deps.rulesLazySuffix,
			overrides.skillsPromptSuffix ?? deps.skillsPromptSuffix,
			formatMcpForPrompt(deps.mcpResult),
			cwd,
			{
				// The Model line reports the model actually in use — in plan mode
				// with an override that's the plan model, not session.model.
				model: deps.planMode && deps.planModel ? deps.planModel : deps.session.model,
				reasoningLevel: deps.config.reasoningLevel,
				reasoningMeta: deps.reasoningMeta,
				mode: deps.planMode ? "plan" : "build",
			},
		),
	);
}

/** Helper: warning + persist for permission mode changes (matches basic). */
async function applyPermissionMode(deps: CommandDeps, newMode: PermissionMode): Promise<void> {
	if (newMode === "bypass" && deps.permissionMode !== "bypass") {
		const picked = await deps.pickers.pickOption(
			[
				{ value: true, label: "Yes, enable bypass (no confirmation for any bash command)" },
				{ value: false, label: "Cancel" },
			],
			{ title: "Warning: bypass disables confirmation for rm -rf, sudo, force-push, ... — saved to settings.json" },
		);
		if (picked !== true) {
			deps.showNotice("Cancelled — staying in default mode.");
			return;
		}
	}
	deps.setPermissionMode(newMode);
	updateSettings({ permissionMode: newMode });
	deps.showNotice(`Permission mode: ${newMode}`);
}

async function reloadSkillsAfterPluginChange(deps: CommandDeps): Promise<void> {
	const { skills, skillsPromptSuffix } = await resolveSkillsForCwd(deps.projectDeps, deps.cwd, deps.projectTrusted);
	deps.setSkills(skills);
	deps.setSkillsPromptSuffix(skillsPromptSuffix);
	rebuildSystemPrompt(deps, deps.cwd, { skillsPromptSuffix });
}

const SKILLS_HELP = `Skills — pick a row from the /skills palette, or type:

  /skills                      Toggle on/off (multi-select, like /mcp)
  /skills list                 What's loaded (source + enabled)
  /skills enable|disable NAME
  /skills uninstall            Pick global/project skill to remove
  /skills uninstall NAME

Add skills via ~/.cast/skills/, .cast/skills/, .agents/skills/ (npx skills add),
/plugin install, or --skill.
Builtin and plugin skills: disable or /plugin uninstall — not /skills uninstall.`;

const MCP_HELP = `MCP — pick a row from the /mcp palette, or type:

  /mcp                         Toggle servers on/off (multi-select)
  /mcp list                    Configured servers + status
  /mcp enable|disable NAME
  /mcp uninstall               Pick server to remove from mcp.json
  /mcp uninstall NAME

Add servers via ~/.cast/mcp.json, .cast/mcp.json, or --mcp.
CLI --mcp paths are not removable with /mcp uninstall.`;

const PLUGIN_HELP = `Plugins — pick a row from the /plugin palette, or type:

  /plugin                      Toggle installed on/off (like /skills /mcp)
  /plugin list                 What's installed
  /plugin install NAME@SHOP    e.g. superpowers@xai-official
  /plugin uninstall            Pick installed to remove
  /plugin uninstall NAME@SHOP
  /plugin enable|disable NAME@SHOP

  /plugin marketplace list           Catalogs (openai-curated, claude-…, xai-official)
  /plugin marketplace list SHOP      Plugins inside one catalog
  /plugin marketplace add owner/repo
  /plugin marketplace update|remove SHOP

Defaults seed once: openai/plugins · anthropics/claude-plugins-official · xai-org/plugin-marketplace

Flow:  /plugin marketplace list xai-official
       /plugin install superpowers@xai-official
       /skills`;

/** One-shot Codex/Claude/Grok marketplace seed; surfaces a short notice if anything new landed. */
function seedDefaultMarketplaces(deps: CommandDeps): void {
	const result = ensureDefaultMarketplaces();
	if (!result.seeded) return;
	const parts: string[] = [];
	if (result.added.length > 0) parts.push(`added ${result.added.join(", ")}`);
	if (result.errors.length > 0) parts.push(`failed: ${result.errors.join("; ")}`);
	if (parts.length === 0) return;
	deps.agent.addDisplayMessage({
		role: "warning",
		content: `[Default marketplaces: ${parts.join(" — ")}]`,
	});
}

async function confirmUninstall(deps: CommandDeps, title: string, yesLabel: string): Promise<boolean> {
	const confirm = await deps.pickers.pickOption(
		[
			{ value: true, label: yesLabel },
			{ value: false, label: "Cancel" },
		],
		{ title },
	);
	if (confirm !== true) {
		deps.showNotice("[Cancelled]");
		return false;
	}
	return true;
}

async function togglePluginsPicker(deps: CommandDeps): Promise<void> {
	seedDefaultMarketplaces(deps);
	const installed = listInstalledPlugins(loadSettings());
	if (installed.length === 0) {
		deps.agent.addDisplayMessage({
			role: "warning",
			content: "No plugins installed. Use /plugin marketplace add, then /plugin install name@marketplace",
		});
		return;
	}
	const enabledIds = await selectPlugins(deps.pickers, installed);
	if (enabledIds === null) {
		deps.showNotice("[Cancelled]");
		return;
	}
	const enabledSet = new Set<string>(enabledIds);
	const enabledPlugins: Record<string, boolean> = {};
	for (const p of installed) {
		enabledPlugins[p.id] = enabledSet.has(p.id);
	}
	const prev = new Set<string>(installed.filter((p) => p.enabled).map((p) => p.id));
	const toEnable = enabledIds.filter((id) => !prev.has(id));
	const toDisable = installed.filter((p) => p.enabled && !enabledSet.has(p.id)).map((p) => p.id);
	if (toEnable.length === 0 && toDisable.length === 0) return;
	updateSettings({ enabledPlugins });
	await reloadSkillsAfterPluginChange(deps);
	deps.agent.addDisplayMessage({
		role: "warning",
		content: `[Plugins: enabled ${toEnable.length}, disabled ${toDisable.length}]`,
	});
}

/** Apply uninstall + settings + skill reload (shared by typed ref and picker). */
async function applyPluginUninstall(deps: CommandDeps, ref: string): Promise<void> {
	const result = uninstallPlugin(ref, loadSettings());
	updateSettings({
		enabledPlugins: Object.keys(result.enabledPlugins).length > 0 ? result.enabledPlugins : undefined,
	});
	await reloadSkillsAfterPluginChange(deps);
	deps.agent.addDisplayMessage({ role: "warning", content: `[Uninstalled ${result.id}]` });
}

/** Bare `/plugin uninstall` — pick an installed plugin, confirm, remove (like /provider delete). */
async function uninstallPluginInteractive(deps: CommandDeps): Promise<void> {
	const installed = listInstalledPlugins(loadSettings());
	if (installed.length === 0) {
		deps.agent.addDisplayMessage({
			role: "warning",
			content: "No plugins installed. Use /plugin marketplace add, then /plugin install name@marketplace",
		});
		return;
	}
	const picked = await deps.pickers.pickOption(
		[...installed]
			.sort((a, b) => a.id.localeCompare(b.id))
			.map((p) => ({
				value: p.id,
				label: `${p.id}${p.enabled ? "" : " (disabled)"}`,
				description: p.description?.trim() || undefined,
			})),
		{ title: "Uninstall which plugin?" },
	);
	if (!picked) {
		deps.showNotice("[Cancelled]");
		return;
	}
	if (!(await confirmUninstall(deps, `Uninstall plugin "${picked}"?`, `Yes, uninstall "${picked}"`))) return;
	await applyPluginUninstall(deps, picked);
}

async function applySkillUninstall(deps: CommandDeps, skill: Skill): Promise<void> {
	uninstallUserSkill(skill);
	const disabled = (loadSettings().disabledSkills ?? []).filter((n) => n !== skill.name);
	updateSettings({ disabledSkills: disabled.length > 0 ? disabled : undefined });
	await reloadSkillsAfterPluginChange(deps);
	deps.agent.addDisplayMessage({
		role: "warning",
		content: `[Uninstalled skill ${skill.name} (${skill.source})]`,
	});
}

async function uninstallSkillInteractive(deps: CommandDeps): Promise<void> {
	const discovered = discoverSkillsForCwd(deps.projectDeps, deps.cwd, deps.projectTrusted);
	const removable = discovered.filter(isUninstallableSkill);
	const pluginSkills = discovered.filter((s) => s.source === "plugin");
	if (removable.length === 0 && pluginSkills.length === 0) {
		deps.agent.addDisplayMessage({
			role: "warning",
			content:
				"No uninstallable skills (.cast / .agents only). Builtin/plugin: disable or /plugin uninstall; --skill paths are CLI-owned.",
		});
		return;
	}
	const disabled = new Set(loadSettings().disabledSkills ?? []);
	const options: PickOption<string>[] = [
		...removable.map((s) => ({
			value: s.name,
			label: `${s.name} (${s.source}${disabled.has(s.name) ? ", disabled" : ""})`,
			description: s.description,
		})),
		...pluginSkills.map((s) => ({
			value: s.name,
			label: `${s.name} (plugin · ${s.pluginId ?? "pack"})`,
			description: `Remove the pack with /plugin uninstall. ${s.description}`.trim(),
			muted: true,
			locked: true,
		})),
	].sort((a, b) => a.value.localeCompare(b.value));
	const firstSelectable = options.findIndex((o) => !o.locked);
	const picked = await deps.pickers.pickOption(options, {
		title: "Uninstall which skill?",
		defaultIndex: firstSelectable >= 0 ? firstSelectable : 0,
	});
	if (!picked) {
		deps.showNotice("[Cancelled]");
		return;
	}
	const skill = removable.find((s) => s.name === picked);
	if (!skill) {
		deps.showNotice(`[Skill "${picked}" comes from a plugin — use /plugin uninstall]`);
		return;
	}
	if (
		!(await confirmUninstall(
			deps,
			`Uninstall skill "${skill.name}" (${skill.source})?`,
			`Yes, uninstall "${skill.name}"`,
		))
	) {
		return;
	}
	await applySkillUninstall(deps, skill);
}

async function setSkillEnabled(deps: CommandDeps, name: string, enable: boolean): Promise<void> {
	const discovered = discoverSkillsForCwd(deps.projectDeps, deps.cwd, deps.projectTrusted);
	const skill = discovered.find((s) => s.name === name);
	if (!skill) {
		deps.showNotice(`[No skill named "${name}". Use /skills list.]`);
		return;
	}
	if (enable && skill.source === "plugin" && skill.pluginEnabled === false) {
		deps.showNotice(`[Enable plugin ${skill.pluginId ?? "pack"} with /plugin first]`);
		return;
	}
	const disabled = new Set(loadSettings().disabledSkills ?? []);
	if (enable) disabled.delete(name);
	else disabled.add(name);
	const next = [...disabled];
	updateSettings({ disabledSkills: next.length > 0 ? next : undefined });
	await reloadSkillsAfterPluginChange(deps);
	deps.agent.addDisplayMessage({
		role: "warning",
		content: `[Skill ${name} ${enable ? "enabled" : "disabled"}]`,
	});
}

function formatSkillsList(deps: CommandDeps): string {
	const discovered = discoverSkillsForCwd(deps.projectDeps, deps.cwd, deps.projectTrusted);
	if (discovered.length === 0) {
		return "No skills found. See --skill <path>, /plugin install, .cast/skills/, .agents/skills/";
	}
	const disabled = new Set(loadSettings().disabledSkills ?? []);
	const lines = [...discovered]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((s) => {
			const packOff = s.source === "plugin" && s.pluginEnabled === false;
			const meta = formatSkillPickLabel(s, disabled.has(s.name));
			const state = packOff ? "lock" : disabled.has(s.name) ? "off" : "on ";
			return `${state} ${meta.label} — ${s.description}`;
		});
	return `Skills\n${lines.join("\n")}`;
}

async function handleSkillsCommand(input: string, deps: CommandDeps): Promise<void> {
	const { showNotice } = deps;
	deps.agent.addDisplayMessage({ role: "user", content: input });
	const args = input === "/skills" ? "" : input.slice("/skills ".length).trim();
	if (args === "help") {
		deps.agent.addDisplayMessage({ role: "warning", content: SKILLS_HELP });
		return;
	}
	if (!args) {
		const discovered = discoverSkillsForCwd(deps.projectDeps, deps.cwd, deps.projectTrusted);
		if (discovered.length === 0) {
			deps.agent.addDisplayMessage({
				role: "warning",
				content: "No skills found. See --skill <path>, /plugin install, .cast/skills/, .agents/skills/",
			});
			return;
		}
		const settings = loadSettings();
		const disabledNames = settings.disabledSkills ?? [];
		const enabledNames = await selectSkills(deps.pickers, discovered, disabledNames);
		if (enabledNames === null) {
			showNotice("[Cancelled]");
			return;
		}
		const enabledSet = new Set(enabledNames);
		// Pack-off plugin skills stay out of disabledSkills — gating is via `/plugin`.
		const toggleable = discovered.filter((s) => !(s.source === "plugin" && s.pluginEnabled === false));
		const newDisabled = toggleable.map((s) => s.name).filter((n) => !enabledSet.has(n));
		const oldDisabledSet = new Set(disabledNames);
		const newDisabledSet = new Set(newDisabled);
		const toEnable = toggleable.map((s) => s.name).filter((n) => oldDisabledSet.has(n) && !newDisabledSet.has(n));
		const toDisable = toggleable.map((s) => s.name).filter((n) => !oldDisabledSet.has(n) && newDisabledSet.has(n));
		if (toEnable.length === 0 && toDisable.length === 0) return;
		updateSettings({ disabledSkills: newDisabled.length > 0 ? newDisabled : undefined });
		await reloadSkillsAfterPluginChange(deps);
		deps.agent.addDisplayMessage({
			role: "warning",
			content: `[Skills: enabled ${toEnable.length}, disabled ${toDisable.length}]`,
		});
		return;
	}

	const [verb, ...rest] = args.split(/\s+/);
	const name = rest.join(" ").trim();
	if (verb === "list") {
		deps.agent.addDisplayMessage({ role: "warning", content: formatSkillsList(deps) });
		return;
	}
	if (verb === "enable" || verb === "disable") {
		if (!name) {
			showNotice(`[Usage: /skills ${verb} <name>]`);
			return;
		}
		await setSkillEnabled(deps, name, verb === "enable");
		return;
	}
	if (verb === "uninstall") {
		if (!name) {
			await uninstallSkillInteractive(deps);
			return;
		}
		const discovered = discoverSkillsForCwd(deps.projectDeps, deps.cwd, deps.projectTrusted);
		const skill = discovered.find((s) => s.name === name);
		if (!skill) {
			showNotice(`[No skill named "${name}". Use /skills list.]`);
			return;
		}
		if (!isUninstallableSkill(skill)) {
			showNotice(
				`[Cannot uninstall ${skill.source} skill "${name}". Use /plugin uninstall for plugin skills; builtin/--skill are not removable here.]`,
			);
			return;
		}
		if (
			!(await confirmUninstall(
				deps,
				`Uninstall skill "${skill.name}" (${skill.source})?`,
				`Yes, uninstall "${skill.name}"`,
			))
		) {
			return;
		}
		await applySkillUninstall(deps, skill);
		return;
	}
	showNotice(`[Unknown /skills ${verb}. See /skills help]`);
}

async function reloadMcpAfterChange(deps: CommandDeps, disabledServers: string[]): Promise<void> {
	await closeMcpConnections(deps.mcpResult.connections);
	const newResult = await resolveMcpForCwd(deps.projectDeps, deps.cwd, deps.projectTrusted, disabledServers);
	deps.setMcpResult(newResult);
	rebuildSystemPrompt(deps, deps.cwd);
}

async function applyMcpUninstall(deps: CommandDeps, name: string): Promise<void> {
	const removed = removeMcpServerFromDisk(name, deps.cwd, deps.projectTrusted);
	if (!removed) {
		deps.showNotice(`[No uninstallable MCP server named "${name}". Use /mcp list.]`);
		return;
	}
	const disabled = (loadSettings().disabledMcpServers ?? []).filter((n) => n !== name);
	updateSettings({ disabledMcpServers: disabled.length > 0 ? disabled : undefined });
	await reloadMcpAfterChange(deps, disabled);
	deps.agent.addDisplayMessage({
		role: "warning",
		content: `[Uninstalled MCP ${name} (${removed.origin})]`,
	});
}

async function uninstallMcpInteractive(deps: CommandDeps): Promise<void> {
	const removable = listUninstallableMcpServers(deps.cwd, deps.projectTrusted);
	if (removable.length === 0) {
		deps.agent.addDisplayMessage({
			role: "warning",
			content:
				"No uninstallable MCP servers in ~/.cast/mcp.json or .cast/mcp.json. CLI --mcp paths are not removable here.",
		});
		return;
	}
	const disabled = new Set(loadSettings().disabledMcpServers ?? []);
	const toolCounts: Record<string, number> = {};
	for (const c of deps.mcpResult.connections) toolCounts[c.serverName] = c.toolCount;
	const blurbs = mcpServerToolBlurbs(deps.mcpResult);
	const picked = await deps.pickers.pickOption(
		[...removable]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((s) => {
				const count = toolCounts[s.name];
				const status = disabled.has(s.name) ? "disabled" : count !== undefined ? `${count} tools` : "disconnected";
				return {
					value: s.name,
					label: `${s.name} (${s.origin}, ${status})`,
					description: blurbs[s.name] || (status === "disconnected" ? "Not connected" : undefined),
				};
			}),
		{ title: "Uninstall which MCP server?" },
	);
	if (!picked) {
		deps.showNotice("[Cancelled]");
		return;
	}
	if (!(await confirmUninstall(deps, `Uninstall MCP server "${picked}"?`, `Yes, uninstall "${picked}"`))) return;
	await applyMcpUninstall(deps, picked);
}

async function setMcpServerEnabled(deps: CommandDeps, name: string, enable: boolean): Promise<void> {
	const allNames = deps.mcpResult.allServerNames;
	if (!allNames.includes(name)) {
		deps.showNotice(`[No MCP server named "${name}". Use /mcp list.]`);
		return;
	}
	const disabled = new Set(loadSettings().disabledMcpServers ?? []);
	if (enable) disabled.delete(name);
	else disabled.add(name);
	const next = [...disabled];
	updateSettings({ disabledMcpServers: next.length > 0 ? next : undefined });
	await reloadMcpAfterChange(deps, next);
	deps.agent.addDisplayMessage({
		role: "warning",
		content: `[MCP ${name} ${enable ? "enabled" : "disabled"}]`,
	});
}

function formatMcpList(deps: CommandDeps): string {
	const allNames = deps.mcpResult.allServerNames;
	if (allNames.length === 0) {
		return "No MCP servers configured. See --mcp <path>, .cast/mcp.json";
	}
	const disabled = new Set(loadSettings().disabledMcpServers ?? []);
	const toolCounts: Record<string, number> = {};
	for (const c of deps.mcpResult.connections) toolCounts[c.serverName] = c.toolCount;
	const ownership = new Map(listUninstallableMcpServers(deps.cwd, deps.projectTrusted).map((s) => [s.name, s.origin]));
	const lines = [...allNames]
		.sort((a, b) => a.localeCompare(b))
		.map((name) => {
			const count = toolCounts[name];
			const origin = ownership.get(name) ?? "cli";
			const status = disabled.has(name) ? "disabled" : count !== undefined ? `${count} tools` : "disconnected";
			return `${disabled.has(name) ? "off" : "on "} ${name} (${origin}, ${status})`;
		});
	return `MCP\n${lines.join("\n")}`;
}

async function handleMcpCommand(input: string, deps: CommandDeps): Promise<void> {
	const { showNotice } = deps;
	deps.agent.addDisplayMessage({ role: "user", content: input });
	const args = input === "/mcp" ? "" : input.slice("/mcp ".length).trim();
	if (args === "help") {
		deps.agent.addDisplayMessage({ role: "warning", content: MCP_HELP });
		return;
	}
	if (!args) {
		const allNames = deps.mcpResult.allServerNames;
		if (allNames.length === 0) {
			deps.agent.addDisplayMessage({
				role: "warning",
				content: "No MCP servers configured. See --mcp <path>, .cast/mcp.json",
			});
			return;
		}
		const settings = loadSettings();
		const disabledNames = settings.disabledMcpServers ?? [];
		const toolCounts: Record<string, number> = {};
		for (const c of deps.mcpResult.connections) toolCounts[c.serverName] = c.toolCount;
		const enabledNames = await selectMcpServers(
			deps.pickers,
			allNames,
			disabledNames,
			toolCounts,
			mcpServerToolBlurbs(deps.mcpResult),
		);
		if (enabledNames === null) {
			showNotice("[Cancelled]");
			return;
		}
		const newDisabled = allNames.filter((n) => !enabledNames.includes(n));
		const oldDisabledSet = new Set(disabledNames);
		const newDisabledSet = new Set(newDisabled);
		const toEnable = allNames.filter((n) => oldDisabledSet.has(n) && !newDisabledSet.has(n));
		const toDisable = allNames.filter((n) => !oldDisabledSet.has(n) && newDisabledSet.has(n));
		if (toEnable.length === 0 && toDisable.length === 0) return;
		updateSettings({ disabledMcpServers: newDisabled.length > 0 ? newDisabled : undefined });
		await reloadMcpAfterChange(deps, newDisabled);
		deps.agent.addDisplayMessage({
			role: "warning",
			content: `[MCP: enabled ${toEnable.length}, disabled ${toDisable.length}]`,
		});
		return;
	}

	const [verb, ...rest] = args.split(/\s+/);
	const name = rest.join(" ").trim();
	if (verb === "list") {
		deps.agent.addDisplayMessage({ role: "warning", content: formatMcpList(deps) });
		return;
	}
	if (verb === "enable" || verb === "disable") {
		if (!name) {
			showNotice(`[Usage: /mcp ${verb} <name>]`);
			return;
		}
		await setMcpServerEnabled(deps, name, verb === "enable");
		return;
	}
	if (verb === "uninstall") {
		if (!name) {
			await uninstallMcpInteractive(deps);
			return;
		}
		const removable = listUninstallableMcpServers(deps.cwd, deps.projectTrusted);
		if (!removable.some((s) => s.name === name)) {
			showNotice(`[No uninstallable MCP server named "${name}". Use /mcp list.]`);
			return;
		}
		if (!(await confirmUninstall(deps, `Uninstall MCP server "${name}"?`, `Yes, uninstall "${name}"`))) return;
		await applyMcpUninstall(deps, name);
		return;
	}
	showNotice(`[Unknown /mcp ${verb}. See /mcp help]`);
}

async function handlePluginCommand(input: string, deps: CommandDeps): Promise<void> {
	const { showNotice } = deps;
	deps.agent.addDisplayMessage({ role: "user", content: input });
	const args = input === "/plugin" ? "" : input.slice("/plugin ".length).trim();
	if (args === "help") {
		deps.agent.addDisplayMessage({ role: "warning", content: PLUGIN_HELP });
		return;
	}
	if (!args) {
		await togglePluginsPicker(deps);
		return;
	}

	const [verb, ...rest] = args.split(/\s+/);
	const restJoined = rest.join(" ").trim();

	// Any marketplace/install command should see the defaults.
	if (verb === "marketplace" || verb === "install" || verb === "list") {
		seedDefaultMarketplaces(deps);
	}

	try {
		if (verb === "list") {
			const installed = listInstalledPlugins(loadSettings());
			if (installed.length === 0) {
				deps.agent.addDisplayMessage({
					role: "warning",
					content: "No plugins installed. Use /plugin marketplace add, then /plugin install name@marketplace",
				});
				return;
			}
			const lines = [...installed]
				.sort((a, b) => a.id.localeCompare(b.id))
				.map((p) => `${p.enabled ? "on " : "off"} ${p.id}${p.description ? ` — ${p.description}` : ""}`);
			deps.agent.addDisplayMessage({ role: "warning", content: `Plugins\n${lines.join("\n")}` });
			return;
		}

		if (verb === "install") {
			if (!restJoined || !parsePluginRef(restJoined)) {
				showNotice("[Usage: /plugin install name@marketplace]");
				return;
			}
			showNotice(`[Installing ${restJoined}…]`);
			const result = installPlugin(restJoined, loadSettings());
			updateSettings({ enabledPlugins: result.enabledPlugins });
			await reloadSkillsAfterPluginChange(deps);
			deps.agent.addDisplayMessage({
				role: "warning",
				content: `[Installed ${result.id}] skills from ${result.root}`,
			});
			return;
		}

		if (verb === "uninstall") {
			if (!restJoined) {
				await uninstallPluginInteractive(deps);
				return;
			}
			if (!parsePluginRef(restJoined)) {
				showNotice("[Usage: /plugin uninstall  or  /plugin uninstall name@marketplace]");
				return;
			}
			if (!(await confirmUninstall(deps, `Uninstall plugin "${restJoined}"?`, `Yes, uninstall "${restJoined}"`))) {
				return;
			}
			await applyPluginUninstall(deps, restJoined);
			return;
		}

		if (verb === "enable" || verb === "disable") {
			if (!restJoined || !parsePluginRef(restJoined)) {
				showNotice(`[Usage: /plugin ${verb} name@marketplace]`);
				return;
			}
			const result = setPluginEnabled(restJoined, verb === "enable", loadSettings());
			updateSettings({ enabledPlugins: result.enabledPlugins });
			await reloadSkillsAfterPluginChange(deps);
			deps.agent.addDisplayMessage({
				role: "warning",
				content: `[Plugin ${result.id} ${verb}d]`,
			});
			return;
		}

		if (verb === "marketplace") {
			const sub = rest[0];
			const subArgs = rest.slice(1).join(" ").trim();
			if (!sub || sub === "help") {
				deps.agent.addDisplayMessage({ role: "warning", content: PLUGIN_HELP });
				return;
			}
			if (sub === "list") {
				if (subArgs) {
					const catalog = getMarketplaceCatalog(subArgs);
					const lines = [...catalog.plugins]
						.sort((a, b) => a.name.localeCompare(b.name))
						.map((p) => `${p.name}${p.description ? ` — ${p.description}` : ""}`);
					deps.agent.addDisplayMessage({
						role: "warning",
						content: `Marketplace ${catalog.name} (${catalog.plugins.length})\n${lines.join("\n") || "(empty)"}`,
					});
					return;
				}
				const known = listKnownMarketplaces();
				if (known.length === 0) {
					deps.agent.addDisplayMessage({
						role: "warning",
						content: "No marketplaces. Add one: /plugin marketplace add owner/repo",
					});
					return;
				}
				const lines = known.map((m) => `${m.name} ← ${m.source}`);
				deps.agent.addDisplayMessage({ role: "warning", content: `Marketplaces\n${lines.join("\n")}` });
				return;
			}
			if (sub === "add") {
				if (!subArgs) {
					showNotice("[Usage: /plugin marketplace add owner/repo|url|path]");
					return;
				}
				showNotice(`[Adding marketplace ${subArgs}…]`);
				const mp = addMarketplace(subArgs);
				deps.agent.addDisplayMessage({
					role: "warning",
					content: `[Marketplace added: ${mp.name}] → /plugin install <name>@${mp.name}`,
				});
				return;
			}
			if (sub === "update") {
				if (!subArgs) {
					showNotice("[Usage: /plugin marketplace update <name>]");
					return;
				}
				showNotice(`[Updating marketplace ${subArgs}…]`);
				const mp = updateMarketplace(subArgs);
				deps.agent.addDisplayMessage({ role: "warning", content: `[Marketplace updated: ${mp.name}]` });
				return;
			}
			if (sub === "remove") {
				if (!subArgs) {
					showNotice("[Usage: /plugin marketplace remove <name>]");
					return;
				}
				const removedIds = removeMarketplace(subArgs);
				const enabled = { ...(loadSettings().enabledPlugins ?? {}) };
				for (const id of Object.keys(enabled)) {
					if (parsePluginRef(id)?.marketplace === subArgs || removedIds.includes(id)) {
						delete enabled[id];
					}
				}
				updateSettings({ enabledPlugins: Object.keys(enabled).length > 0 ? enabled : undefined });
				await reloadSkillsAfterPluginChange(deps);
				deps.agent.addDisplayMessage({
					role: "warning",
					content: `[Marketplace removed: ${subArgs}${removedIds.length > 0 ? ` (${removedIds.length} plugins)` : ""}]`,
				});
				return;
			}
			showNotice(`[Unknown /plugin marketplace ${sub}. See /plugin help]`);
			return;
		}

		showNotice(`[Unknown /plugin ${verb}. See /plugin help]`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		deps.agent.addDisplayMessage({ role: "warning", content: `[plugin] ${message}` });
	}
}

/** Commands allowed while the agent is running — plain text is rejected. */
const RUNNING_COMMANDS = new Set(["/queue", "/q", "/queue-reset", "/qr", "/steer", "/s", "/abort", "/stop"]);

export function canSubmitDuringRun(text: string): boolean {
	const input = text.trim();
	if (!input.startsWith("/")) return false;
	const cmd = input.split(/\s+/)[0]!;
	return RUNNING_COMMANDS.has(cmd);
}

/**
 * Route a line of user input. Every slash command is handled
 * here (parity or it's a bug); non-slash input goes to the agent as a prompt.
 */
export async function handleInput(text: string, images: PendingImage[] | undefined, deps: CommandDeps): Promise<void> {
	const { agent, session, config, running, onQuit, showNotice } = deps;
	const input = text.trim();

	if (!input) return;

	if (!input.startsWith("/")) {
		await agent.submit(text, images);
		return;
	}

	if (input === "/quit" || input === "/exit") {
		onQuit();
		return;
	}
	if (input === "/abort" || input === "/stop") {
		agent.abort();
		return;
	}
	if (input === "/steer" || input.startsWith("/steer ") || input === "/s" || input.startsWith("/s ")) {
		const cmd = input.startsWith("/steer") ? "/steer" : "/s";
		const msg = input.slice(cmd.length).trim();
		if (!msg) {
			showNotice("[Usage: /steer <message> — injects it into the running turn]");
			return;
		}
		// Nothing running to steer — send it as a normal message instead.
		if (!running) {
			await agent.submit(msg, images);
			return;
		}
		// No transient showNotice on success — agent.pendingSteers now renders
		// above the composer for as long as the message is actually queued (see
		// App.tsx), not on a fixed timer that could clear it long before a
		// tool-heavy turn gets around to draining the queue.
		agent.steer(msg);
		return;
	}
	if (input === "/queue-reset" || input === "/qr") {
		agent.resetQueue();
		showNotice("[Queue cleared]");
		return;
	}
	if (input === "/queue" || input.startsWith("/queue ") || input === "/q" || input.startsWith("/q ")) {
		const cmd = input.startsWith("/queue") ? "/queue" : "/q";
		const msg = input.slice(cmd.length).trim();
		if (!msg) {
			showNotice("[Usage: /queue <message> — runs after the current turn]");
			return;
		}
		// Nothing to queue behind when idle — just run it now as a normal turn,
		// which is what the user means by "do this next".
		if (!running) {
			await agent.submit(msg, images);
			return;
		}
		agent.followUp(msg);
		return;
	}

	if (running) {
		showNotice("[Agent running — use /queue, /steer, or /abort]");
		return;
	}

	if (input === "/copy") {
		for (let i = session.messages.length - 1; i >= 0; i--) {
			const msg = session.messages[i]!;
			if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.length > 0) {
				const text = msg.content;
				try {
					const platform = process.platform;
					if (platform === "darwin") execSync("pbcopy", { input: text });
					else if (platform === "linux") execSync("xclip -selection clipboard", { input: text });
					else if (platform === "win32") execSync("clip", { input: Buffer.from(text, "utf-16le") });
					else {
						showNotice("[Clipboard not supported on this platform]");
						return;
					}
					showNotice(`[Copied ${text.length} chars to clipboard]`);
				} catch (err) {
					showNotice(`[Copy failed: ${err instanceof Error ? err.message : String(err)}]`);
				}
				return;
			}
		}
		showNotice("[No assistant response to copy]");
		return;
	}

	if (input === "/plan") {
		// A run captures its tool set and system prompt at start; flipping the
		// mode under it would leave the prompt claiming one thing while the
		// executor gate enforces another. Modes only change between runs.
		if (deps.running) {
			showNotice("[Agent running — finish the run or /abort before switching modes]");
			return;
		}
		if (deps.planMode) {
			showNotice("[Already in plan mode]");
			return;
		}
		deps.setPlanMode(true);
		// MCP tools are a documented exception: plan mode hard-gates only the
		// built-in tools, so connected MCP servers keep their full capability.
		// The model is told to treat them as read-only, but that's prompt-level
		// — the user should know the guarantee is weaker there.
		const mcpCount = deps.mcpResult.toolDefinitions.length;
		showNotice(
			mcpCount > 0
				? `[Plan mode: ON — exploring and planning only · ${mcpCount} MCP tool${mcpCount === 1 ? "" : "s"} stay fully enabled (not gated by plan mode)]`
				: "[Plan mode: ON — exploring and planning only]",
		);
		return;
	}

	if (input === "/build") {
		if (deps.running) {
			showNotice("[Agent running — finish the run or /abort before switching modes]");
			return;
		}
		if (!deps.planMode) {
			showNotice("[Not in plan mode]");
			return;
		}
		deps.setPlanMode(false);
		// With a plan on disk, /build is the approval gesture: the loop injects
		// the plan into the build-mode system prompt, so the user's next message
		// (however phrased) starts implementation guided by it.
		const hasPlan = readActivePlan(createPlanState(session.id)).exists;
		showNotice(
			hasPlan
				? "[Plan mode: OFF — plan approved; your next message starts implementation]"
				: "[Plan mode: OFF — full toolset restored]",
		);
		return;
	}

	if (input === "/clear") {
		agent.clearContext();
		showNotice("[Context cleared]");
		return;
	}

	if (input === "/compact") {
		showNotice("[Compacting...]");
		try {
			const planState = createPlanState(session.id);
			planState.enabled = deps.planMode;
			const result = await compactSessionMessages(
				session.messages,
				config,
				session.model,
				undefined,
				(attempt, maxAttempts, reason) => showNotice(`[Retry ${attempt}/${maxAttempts}: ${reason}]`),
				(usage) => addUsage(session, usage),
				deps.planMode ? PLAN_COMPACTION_PROMPT : undefined,
				reminderStateFromPlan(planState),
			);
			if (result.compacted) {
				session.messages = result.messages;
				agent.refresh();
				showNotice(`[Compacted: ${result.messagesCompacted} msgs (~${result.tokensBefore} tokens)]`);
			} else if (result.error) {
				showNotice(`[Compaction failed: ${result.error}]`);
			} else {
				showNotice("[Nothing to compact yet]");
			}
		} catch (err) {
			showNotice(`[Compaction error: ${err instanceof Error ? err.message : String(err)}]`);
		}
		return;
	}

	if (input === "/new") {
		if (session.messages.length > 0) saveSession(session);
		const fresh = createSession(session.model, deps.cwd);
		session.id = fresh.id;
		session.messages = fresh.messages;
		session.createdAt = fresh.createdAt;
		session.updatedAt = fresh.updatedAt;
		session.usage = fresh.usage;
		saveSession(session);
		agent.clearContext();
		// A fresh session starts in build mode — plan mode is a per-task state,
		// not a sticky preference.
		deps.setPlanMode(false);
		showNotice(`[New session: ${session.id}]`);
		return;
	}

	if (input === "/model") {
		// Pass the current model so the picker opens highlighting it and marks it
		// "(current)" — that's the "show" half of /model, which otherwise just
		// dropped you straight into a selection list with no sign of where you were.
		const selection = await selectModel(config, deps.pickers, session.model);
		// selectModel returns null on cancel (Escape) rather than exiting the
		// process — it used to call process.exit(0) internally, which meant
		// cancelling this picker mid-session killed the whole running app
		// instead of just leaving the current model in place.
		if (!selection) {
			showNotice("[Cancelled — model unchanged]");
			return;
		}
		session.model = selection.model;
		deps.setReasoningMeta(selection.reasoningMeta);
		if (selection.contextWindow && selection.contextWindow > 0) config.contextWindow = selection.contextWindow;
		await selectReasoningLevel(config, session.model, deps.pickers, selection.reasoningMeta);
		updateSettings({ model: session.model, reasoningLevel: config.reasoningLevel });
		agent.refresh();
		showNotice(`[Model: ${session.model} (reasoning: ${config.reasoningLevel})]`);
		return;
	}

	if (input.startsWith("/model ")) {
		const newModel = input.slice(7).trim();
		const ok = await runOnboardingCheck(config, newModel, { log: deps.pickers.log });
		if (!ok) {
			showNotice(`[Model ${newModel} failed validation]`);
			return;
		}
		session.model = newModel;
		const found = getModelsCache().find((m) => m.id === newModel);
		deps.setReasoningMeta(found?.reasoning);
		if (found?.contextWindow && found.contextWindow > 0) config.contextWindow = found.contextWindow;
		await selectReasoningLevel(config, newModel, deps.pickers, found?.reasoning);
		updateSettings({ model: newModel, reasoningLevel: config.reasoningLevel });
		agent.refresh();
		showNotice(`[Model: ${newModel} (reasoning: ${config.reasoningLevel})]`);
		return;
	}

	if (input === "/plan-model") {
		const selection = await selectModel(config, deps.pickers, deps.planModel ?? session.model);
		if (!selection) {
			showNotice("[Cancelled — plan-mode model unchanged]");
			return;
		}
		deps.setPlanModel(selection.model);
		updateSettings({ planModel: selection.model });
		agent.refresh();
		showNotice(`[Plan-mode model: ${selection.model}]`);
		return;
	}

	if (input.startsWith("/plan-model ")) {
		const newModel = input.slice("/plan-model ".length).trim();
		if (newModel === "off" || newModel === "reset") {
			deps.setPlanModel(undefined);
			updateSettings({ planModel: undefined });
			showNotice("[Plan-mode model: off — plan mode uses the main model]");
			return;
		}
		const ok = await runOnboardingCheck(config, newModel, { log: deps.pickers.log });
		if (!ok) {
			showNotice(`[Model ${newModel} failed validation]`);
			return;
		}
		deps.setPlanModel(newModel);
		updateSettings({ planModel: newModel });
		agent.refresh();
		showNotice(`[Plan-mode model: ${newModel}]`);
		return;
	}

	if (input === "/subagent-model") {
		const current = deps.subagentModel;
		const selection = await selectModel(config, deps.pickers, current);
		if (!selection) {
			showNotice("[Cancelled — subagent model unchanged]");
			return;
		}
		deps.setSubagentModel(selection.model);
		updateSettings({ subagentModel: selection.model });
		agent.refresh();
		showNotice(`[Subagent model: ${selection.model}]`);
		return;
	}

	if (input.startsWith("/subagent-model ")) {
		const newModel = input.slice(16).trim();
		const ok = await runOnboardingCheck(config, newModel, { log: deps.pickers.log });
		if (!ok) {
			showNotice(`[Model ${newModel} failed validation]`);
			return;
		}
		deps.setSubagentModel(newModel);
		updateSettings({ subagentModel: newModel });
		agent.refresh();
		showNotice(`[Subagent model: ${newModel}]`);
		return;
	}

	if (input === "/reasoning") {
		const meta = deps.reasoningMeta ?? getModelsCache().find((m) => m.id === session.model)?.reasoning;
		const options = getReasoningOptions(meta ?? null);
		if (options.length === 0) {
			showNotice(
				"[This provider exposes no reasoning controls — the model uses its own default; any reasoning shows as it streams]",
			);
			return;
		}
		await selectReasoningLevel(config, session.model, deps.pickers, meta);
		updateSettings({ reasoningLevel: config.reasoningLevel });
		showNotice(`[Reasoning: ${config.reasoningLevel}]`);
		return;
	}

	if (input === "/persona") {
		const selected = await selectPersona(deps.pickers, deps.personaOptions);
		if (!selected) {
			showNotice("[Cancelled — persona unchanged]");
			return;
		}
		deps.setCurrentPersona(selected);
		updateSettings({ persona: selected.name });
		rebuildSystemPrompt(deps, deps.cwd, { persona: selected });
		showNotice(`[Persona: ${selected.label}]`);
		return;
	}

	if (input.startsWith("/persona ")) {
		const name = input.slice("/persona ".length).trim();
		const found = findPersona(name, deps.personaOptions);
		if (!found) {
			showNotice(`[Unknown persona "${name}". Use /persona to list available ones.]`);
			return;
		}
		deps.setCurrentPersona(found);
		updateSettings({ persona: found.name });
		rebuildSystemPrompt(deps, deps.cwd, { persona: found });
		showNotice(`[Persona: ${found.label}]`);
		return;
	}

	if (input === "/skills" || input.startsWith("/skills ")) {
		await handleSkillsCommand(input, deps);
		return;
	}

	if (input === "/plugin" || input.startsWith("/plugin ")) {
		await handlePluginCommand(input, deps);
		return;
	}

	if (input === "/mcp" || input.startsWith("/mcp ")) {
		await handleMcpCommand(input, deps);
		return;
	}

	if (input === "/reload") {
		showNotice("[Reloading...]");
		const trusted = await resolveProjectTrustForCwd(deps.projectDeps, deps.cwd);
		deps.setProjectTrusted(trusted);
		const { skills: newSkills, skillsPromptSuffix } = await resolveSkillsForCwd(deps.projectDeps, deps.cwd, trusted);
		deps.setSkills(newSkills);
		deps.setSkillsPromptSuffix(skillsPromptSuffix);
		const contextFilesSuffix = formatContextFilesForPrompt(loadProjectContextFiles(deps.cwd, trusted));
		deps.setContextFilesSuffix(contextFilesSuffix);
		const resolvedRules = resolveRulesForCwd(deps.cwd, trusted);
		const rulesSuffix = resolvedRules.alwaysApplySuffix;
		deps.setRulesSuffix(rulesSuffix);
		deps.setRulesLazySuffix(resolvedRules.lazySuffix);
		deps.setDirectoryRules(resolvedRules.directoryRules);
		deps.setActiveAutoRules([]); // Reset sticky rules on reload
		const newPersonaOpts = personaOptionsForCwd(deps.cwd, trusted);
		deps.setPersonaOptions(newPersonaOpts);
		const reloadedPersona = findPersona(deps.currentPersona.name, newPersonaOpts);
		if (reloadedPersona) {
			deps.setCurrentPersona(reloadedPersona);
		}
		rebuildSystemPrompt(deps, deps.cwd, {
			persona: reloadedPersona,
			contextFilesSuffix,
			rulesSuffix,
			rulesLazySuffix: resolvedRules.lazySuffix,
			skillsPromptSuffix,
		});
		await closeMcpConnections(deps.mcpResult.connections);
		deps.setMcpResult(
			await resolveMcpForCwd(deps.projectDeps, deps.cwd, trusted, loadSettings().disabledMcpServers ?? []),
		);
		showNotice(
			`[Reloaded: ${newSkills.length} skill(s), ${resolvedRules.directoryRules.length} rule(s), ${deps.mcpResult.connections.length} mcp server(s), personas]`,
		);
		return;
	}

	if (input.startsWith("/skill:")) {
		const rest = input.slice("/skill:".length);
		const spaceIdx = rest.indexOf(" ");
		const skillName = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
		const skillArgs = spaceIdx === -1 ? undefined : rest.slice(spaceIdx + 1).trim();
		const skill = deps.skills.find((s) => s.name === skillName);
		if (!skill) {
			const discovered = discoverSkillsForCwd(deps.projectDeps, deps.cwd, deps.projectTrusted);
			if (discovered.some((s) => s.name === skillName)) {
				showNotice(`[Skill "${skillName}" is disabled. Re-enable it with /skills.]`);
			} else {
				showNotice(`[No skill named "${skillName}". Use /skills to toggle available skills.]`);
			}
			return;
		}
		await agent.submit(formatSkillInvocation(skill, skillArgs));
		return;
	}

	// --- /provider helper: shared post-save flow ---
	// Both activateProvider (existing saved provider) and addProviderWizard
	// (newly added) probe + persist credentials before getting here; the rest
	// (pick a model, sync reasoning meta + level, persist, refresh the agent)
	// is identical. Both call sites also use the same notice text shape so
	// the user gets a consistent "select a model / model set" pair.
	async function applyProviderSelection(p: { name: string; url: string; apiKey: string }): Promise<void> {
		showNotice(`[Provider: ${p.name}. Select a model.]`);
		const selection = await selectModel(config, deps.pickers);
		if (!selection) {
			showNotice("[Cancelled — provider updated, but model unchanged]");
			return;
		}
		session.model = selection.model;
		deps.setReasoningMeta(selection.reasoningMeta);
		if (selection.contextWindow && selection.contextWindow > 0) config.contextWindow = selection.contextWindow;
		await selectReasoningLevel(config, session.model, deps.pickers, selection.reasoningMeta);
		updateSettings({ model: session.model, reasoningLevel: config.reasoningLevel });
		agent.refresh();
		showNotice(`[Provider: ${p.name}. Model: ${session.model}]`);
	}

	// --- /provider helper: activate a provider + pick model ---
	async function activateProvider(p: Provider): Promise<void> {
		const probe = await probeProvider({ ...config, baseURL: p.url, apiKey: p.apiKey });
		if (probe !== "ok" && probe !== "unknown") {
			showNotice(`[Cannot reach provider "${p.name}": ${probe}]`);
			return;
		}
		config.baseURL = p.url;
		config.apiKey = p.apiKey;
		updateSettings({ providerUrl: p.url, apiKey: p.apiKey });
		await applyProviderSelection(p);
	}

	// --- /provider helper: add wizard (mirrors /ssh add shape) ---
	async function addProviderWizard(existing: Provider[]): Promise<void> {
		const name = await deps.pickers.promptText("Provider name (e.g. openrouter, local)");
		if (!name) {
			showNotice("[Cancelled]");
			return;
		}
		if (existing.some((p) => p.name === name)) {
			showNotice(`[Provider "${name}" already exists. Use a different name.]`);
			return;
		}
		const url = await deps.pickers.promptText("Provider base URL", undefined, "https://api.openai.com/v1");
		if (!url) {
			showNotice("[Cancelled]");
			return;
		}
		const key = await deps.pickers.promptText("Provider API key", undefined, "sk-...");
		if (!key) {
			showNotice("[Cancelled]");
			return;
		}

		const probe = await probeProvider({ ...config, baseURL: url, apiKey: key });
		if (probe !== "ok" && probe !== "unknown") {
			showNotice(`[Verification failed: ${probe}. Provider not saved.]`);
			return;
		}

		const newProvider: Provider = { name, url, apiKey: key };
		// Single atomic write: providers array + active URL/key in one go.
		updateSettings({
			providers: [...existing, newProvider],
			providerUrl: url,
			apiKey: key,
		});
		config.baseURL = url;
		config.apiKey = key;
		showNotice(`[Provider "${name}" added and selected. Select a model.]`);
		const selection = await selectModel(config, deps.pickers);
		if (selection) {
			session.model = selection.model;
			deps.setReasoningMeta(selection.reasoningMeta);
			if (selection.contextWindow && selection.contextWindow > 0) config.contextWindow = selection.contextWindow;
			await selectReasoningLevel(config, session.model, deps.pickers, selection.reasoningMeta);
			updateSettings({ model: session.model, reasoningLevel: config.reasoningLevel });
			agent.refresh();
		}
		showNotice(`[Provider "${name}" added. Model: ${session.model}]`);
	}

	// --- /provider helper: delete picker ---
	async function deleteProviderWizard(providers: Provider[]): Promise<void> {
		if (providers.length === 0) {
			showNotice("[No providers to delete]");
			return;
		}
		const picked = await deps.pickers.pickOption(
			providers.map((p) => ({ value: p.name, label: `${p.name}  ${p.url}` })),
			{ title: "Delete which provider?" },
		);
		if (!picked) {
			showNotice("[Cancelled]");
			return;
		}
		const confirm = await deps.pickers.pickOption(
			[
				{ value: true, label: `Yes, remove "${picked}"` },
				{ value: false, label: "Cancel" },
			],
			{ title: `Remove provider "${picked}"?` },
		);
		if (confirm !== true) {
			showNotice("[Cancelled]");
			return;
		}

		const updated = providers.filter((p) => p.name !== picked);
		const wasActive = providers.find((p) => p.name === picked);
		const isActive = wasActive && wasActive.url === config.baseURL && wasActive.apiKey === config.apiKey;

		if (isActive && updated.length > 0) {
			// Atomic: drop removed, switch active to the first remaining.
			const fallback = updated[0]!;
			updateSettings({
				providers: updated,
				providerUrl: fallback.url,
				apiKey: fallback.apiKey,
			});
			config.baseURL = fallback.url;
			config.apiKey = fallback.apiKey;
			showNotice(`[Provider "${picked}" removed. Switched to "${fallback.name}".]`);
		} else if (isActive && updated.length === 0) {
			// Clear the legacy providerUrl/apiKey so migrateProviders doesn't
			// resurrect the deleted provider as a "default" entry next startup.
			// Empty strings (not undefined — spread drops undefined keys, which
			// breaks the migration guard on next loadSettings).
			updateSettings({ providers: updated, providerUrl: "", apiKey: "" });
			config.baseURL = "";
			config.apiKey = "";
			showNotice(`[Provider "${picked}" removed. No providers left — use /provider add to add one.]`);
		} else {
			updateSettings({ providers: updated });
			showNotice(`[Provider "${picked}" removed]`);
		}
	}

	if (input === "/provider" || input.startsWith("/provider ")) {
		const sub = input.slice("/provider".length).trim();
		const settings = loadSettings();
		const providers = settings.providers ?? [];

		if (sub === "add") {
			await addProviderWizard(providers);
			return;
		}
		if (sub === "delete") {
			await deleteProviderWizard(providers);
			return;
		}
		if (sub) {
			const found = providers.find((p) => p.name === sub);
			if (!found) {
				showNotice(`[Unknown provider "${sub}". Use /provider to list.]`);
				return;
			}
			await activateProvider(found);
			return;
		}

		// /provider (no subcommand) — picker, or auto-add when empty.
		if (providers.length === 0) {
			showNotice("[No providers configured. Adding a new one.]");
			await addProviderWizard(providers);
			return;
		}
		type ProviderChoice = { provider: Provider } | { action: "add" } | { action: "delete" };
		const options: Array<{ value: ProviderChoice; label: string }> = providers.map((p) => ({
			value: { provider: p },
			label: `${p.name}  ${p.url}${p.url === config.baseURL ? "  (current)" : ""}`,
		}));
		options.push({ value: { action: "add" }, label: "Add a new provider..." });
		options.push({ value: { action: "delete" }, label: "Delete a provider..." });

		const picked = await deps.pickers.pickOption(options, { title: "Providers" });
		if (!picked) {
			showNotice("[Cancelled]");
			return;
		}
		if ("action" in picked) {
			if (picked.action === "add") await addProviderWizard(providers);
			else await deleteProviderWizard(providers);
			return;
		}
		await activateProvider(picked.provider);
		return;
	}

	if (input === "/permissions") {
		const newMode = await selectPermissionMode(deps.pickers, deps.permissionMode);
		await applyPermissionMode(deps, newMode);
		return;
	}

	if (input === "/permissions default" || input === "/permissions bypass") {
		const newMode = input.endsWith("bypass") ? "bypass" : "default";
		await applyPermissionMode(deps, newMode);
		return;
	}

	if (input === "/web") {
		const enabled = deps.webToolsEnabled;
		const picked = await deps.pickers.pickOption(
			[
				{ value: true, label: `Enable web tools (currently ${enabled ? "on" : "off"})` },
				{ value: false, label: `Disable web tools (currently ${enabled ? "on" : "off"})` },
			],
			{ title: "Web tools (web_search, web_fetch)" },
		);
		if (picked === null) {
			showNotice("[Cancelled — web tools unchanged]");
			return;
		}
		deps.setWebToolsEnabled(picked);
		updateSettings({ webTools: picked });
		showNotice(`[Web tools: ${picked ? "enabled" : "disabled"}]`);
		return;
	}

	if (input === "/statusbar") {
		const allSegments = getStatusBarSegments();
		if (!deps.pickers.pickStatusBar) {
			showNotice("[Status bar picker not available in this mode]");
			return;
		}
		const picked = await deps.pickers.pickStatusBar(allSegments, deps.statusBar);
		if (picked === null) {
			showNotice("[Cancelled — status bar unchanged]");
			return;
		}
		// Overflow warning
		const visibleSegs = allSegments.filter((s) => picked.visible.includes(s.id));
		const totalWidth =
			visibleSegs.reduce((sum, s) => sum + (SEGMENT_MAX_WIDTH[s.id] ?? 15), 0) + (visibleSegs.length - 1) * 3;
		const cols = process.stdout.columns ?? 80;
		if (totalWidth > cols) {
			showNotice(`[Warning: status bar (~${totalWidth} cols) may overflow ${cols}-col terminal]`, 10000);
		}
		updateSettings({ statusBar: picked });
		deps.setStatusBar(picked);
		showNotice(`[Status bar: ${picked.visible.length} segment${picked.visible.length === 1 ? "" : "s"}]`);
		return;
	}

	if (input === "/ssh" || input.startsWith("/ssh ")) {
		const sub = input.slice("/ssh".length).trim();
		if (sub === "add") {
			// --- Interactive wizard ---
			const name = await deps.pickers.promptText("SSH host name (e.g. my-server)");
			if (!name) {
				showNotice("[Cancelled]");
				return;
			}
			if (deps.sshHosts.some((h) => h.name === name)) {
				showNotice(`[Host "${name}" already exists. Use a different name.]`);
				return;
			}
			const host = await deps.pickers.promptText("Host address (IP or hostname)");
			if (!host) {
				showNotice("[Cancelled]");
				return;
			}
			const username = await deps.pickers.promptText("Username", undefined, "root");
			if (!username) {
				showNotice("[Cancelled]");
				return;
			}
			const portStr = await deps.pickers.promptText("Port", undefined, "22");
			if (!portStr) {
				showNotice("[Cancelled]");
				return;
			}
			const port = Number.parseInt(portStr, 10) || 22;

			// Auth method
			const authMethod = await deps.pickers.pickOption(
				[
					{ value: "key" as const, label: "Key-based (keyPath)" },
					{ value: "password" as const, label: "Password (requires sshpass)" },
				],
				{ title: "Authentication method" },
			);
			if (!authMethod) {
				showNotice("[Cancelled]");
				return;
			}

			let keyPath: string | undefined;
			let password: string | undefined;

			if (authMethod === "key") {
				const availableKeys = scanSshKeys();
				if (availableKeys.length > 0) {
					const keyOptions = [
						...availableKeys.map((k) => ({ value: k, label: k })),
						{ value: "__other__", label: "Other (enter path)" },
					];
					const picked = await deps.pickers.pickOption(keyOptions, {
						title: "SSH key",
						defaultIndex: 0,
					});
					if (!picked) {
						showNotice("[Cancelled]");
						return;
					}
					if (picked === "__other__") {
						const custom = await deps.pickers.promptText("Key path", undefined, "~/.ssh/id_ed25519");
						if (!custom) {
							showNotice("[Cancelled]");
							return;
						}
						keyPath = custom;
					} else {
						keyPath = picked;
					}
				} else {
					const custom = await deps.pickers.promptText("Key path", undefined, "~/.ssh/id_ed25519");
					if (!custom) {
						showNotice("[Cancelled]");
						return;
					}
					keyPath = custom;
				}
				// Validate key with retry loop
				while (true) {
					const err = keyPath
						? validateKeyPermissions(keyPath.startsWith("~/") ? keyPath.replace("~", homedir()) : keyPath)
						: undefined;
					if (!err) break;
					const retry = await deps.pickers.promptText(err, keyPath, "~/.ssh/id_ed25519");
					if (!retry) {
						showNotice("[Cancelled]");
						return;
					}
					keyPath = retry;
				}
			} else {
				const pw = await deps.pickers.promptText("Password");
				if (!pw) {
					showNotice("[Cancelled]");
					return;
				}
				password = pw;
			}

			// Dangerous commands
			const dangerMode = await deps.pickers.pickOption(
				[
					{ value: "default" as const, label: "Default (block dangerous commands like sudo)" },
					{ value: "bypass" as const, label: "Bypass (allow all commands — for hosts where sudo is expected)" },
				],
				{ title: "Dangerous command policy" },
			);
			if (!dangerMode) {
				showNotice("[Cancelled]");
				return;
			}

			const newHost: SshHost = { name, host, username, port, dangerousCommands: dangerMode };
			if (keyPath) newHost.keyPath = keyPath;
			if (password) newHost.password = password;

			const updated = [...deps.sshHosts, newHost];
			saveSshConfig(updated);
			deps.setSshHosts(updated);
			showNotice(`[SSH host "${name}" added]`);
			return;
		}

		if (sub === "remove" || sub.startsWith("remove ")) {
			const targetName = sub.slice("remove".length).trim();
			if (deps.sshHosts.length === 0) {
				showNotice("[No SSH hosts to remove]");
				return;
			}
			let removeName = targetName;
			if (!removeName) {
				const picked = await deps.pickers.pickOption(
					deps.sshHosts.map((h) => ({
						value: h.name,
						label: `${h.name} (${h.username ? `${h.username}@` : ""}${h.host})`,
					})),
					{ title: "Remove which SSH host?" },
				);
				if (!picked) {
					showNotice("[Cancelled]");
					return;
				}
				removeName = picked;
			}
			const found = deps.sshHosts.find((h) => h.name === removeName);
			if (!found) {
				showNotice(`[Unknown host "${removeName}". Use /ssh to list hosts.]`);
				return;
			}
			const confirm = await deps.pickers.pickOption(
				[
					{ value: true, label: `Yes, remove "${removeName}"` },
					{ value: false, label: "Cancel" },
				],
				{ title: `Remove SSH host "${removeName}"?` },
			);
			if (confirm !== true) {
				showNotice("[Cancelled]");
				return;
			}
			const updated = deps.sshHosts.filter((h) => h.name !== removeName);
			saveSshConfig(updated);
			deps.setSshHosts(updated);
			showNotice(`[SSH host "${removeName}" removed]`);
			return;
		}

		// /ssh (no subcommand) — list hosts
		deps.agent.addDisplayMessage({ role: "user", content: input });
		if (deps.sshHosts.length === 0) {
			deps.agent.addDisplayMessage({
				role: "warning",
				content: "No SSH hosts configured. Use /ssh add to add one, or edit ~/.cast/ssh.json",
			});
			return;
		}
		const lines = deps.sshHosts.map((h) => {
			const user = h.username ? `${h.username}@` : "";
			const auth = h.password ? "password" : "key";
			const danger = h.dangerousCommands === "bypass" ? " (no safety check)" : "";
			return `  ${h.name.padEnd(16)} ${user}${h.host}:${h.port || 22}  ${auth}${danger}`;
		});
		deps.agent.addDisplayMessage({ role: "warning", content: `SSH Hosts\n${lines.join("\n")}` });
		return;
	}

	if (input === "/theme" || input.startsWith("/theme ")) {
		const arg = input.slice("/theme".length).trim();
		if (arg) {
			const found = ALL_THEMES.find((t) => t.id === arg);
			if (!found) {
				showNotice(`[Unknown theme "${arg}". Use /theme to list available.]`);
				return;
			}
			setActiveTheme(found.id);
			updateSettings({ theme: found.id });
			deps.onThemeChange?.();
			showNotice(`[Theme: ${found.label}]`);
			return;
		}
		const currentId = getActiveTheme().id;
		const picked = await deps.pickers.pickOption(
			ALL_THEMES.map((t) => ({
				value: t.id,
				label: `${t.label}${t.id === currentId ? " (current)" : ""}`,
				description: t.description,
			})),
			{ title: "Color themes", defaultIndex: ALL_THEMES.findIndex((t) => t.id === currentId) },
		);
		if (!picked) {
			showNotice("[Cancelled — theme unchanged]");
			return;
		}
		setActiveTheme(picked);
		updateSettings({ theme: picked });
		deps.onThemeChange?.();
		showNotice(`[Theme: ${ALL_THEMES.find((t) => t.id === picked)?.label ?? picked}]`);
		return;
	}

	if (input === "/usage") {
		const u = session.usage;
		if (!u || u.totalTokens === 0) {
			showNotice("[No usage yet this session]");
			return;
		}
		const costStr = u.cost > 0 ? ` | $${u.cost.toFixed(2)}` : "";
		const cacheStr =
			u.cacheReadTokens > 0 && u.promptTokens > 0
				? ` | ${Math.round((u.cacheReadTokens / u.promptTokens) * 100)}% cache hit`
				: "";
		const subStr = u.subagentTokens > 0 ? ` | ${abbreviateTokens(u.subagentTokens)} sub` : "";
		showNotice(
			`[Usage: ${abbreviateTokens(u.promptTokens)} in / ${abbreviateTokens(u.completionTokens)} out${costStr}${cacheStr}${subStr}]`,
		);
		return;
	}

	if (input === "/current") {
		const allSegs = getStatusBarSegments();
		const cfg = deps.statusBar;
		const activeModel = deps.planMode && deps.planModel ? deps.planModel : session.model;
		const ctxForCurrent: SegmentContext = {
			persona: deps.currentPersona.label,
			planMode: deps.planMode,
			activeModel,
			configuredModel: session.model,
			planModel: deps.planModel,
			usage: session.usage,
			lastTurnUsage: agent.lastTurnUsage ? { tokensPerSecond: agent.lastTurnUsage.tokensPerSecond } : undefined,
			elapsedMs: agent.elapsedMs,
			messageCount: session.messages.length,
			contextWindow: config.contextWindow,
			maxResponseTokens: config.maxResponseTokens,
			messages: session.messages,
			sessionId: session.id,
		};
		// Build ordered list from statusBar.order, then append any new segments
		const ordered: StatusBarSegment[] = cfg.order
			.map((id) => allSegs.find((s) => s.id === id))
			.filter(Boolean) as StatusBarSegment[];
		for (const seg of allSegs) {
			if (!ordered.some((s) => s.id === seg.id)) ordered.push(seg);
		}
		const lines: string[] = [];
		lines.push(`  ${"Session".padEnd(16)} ${session.id}`);
		for (const seg of ordered) {
			const value = seg.formatValue(ctxForCurrent) ?? "—";
			lines.push(`  ${seg.label.padEnd(16)} ${value}`);
		}
		deps.agent.addDisplayMessage({ role: "warning", content: `Current\n${lines.join("\n")}` });
		return;
	}

	if (input === "/sessions") {
		const chosen = await selectSession(deps.pickers);
		if (!chosen) {
			showNotice("[Starting fresh — no session resumed.]");
			return;
		}
		if (chosen.id === session.id) {
			showNotice("[Already in that session.]");
			return;
		}
		if (session.messages.length > 0) saveSession(session);
		session.id = chosen.id;
		session.messages = chosen.messages;
		session.model = chosen.model;
		session.createdAt = chosen.createdAt;
		session.updatedAt = chosen.updatedAt;
		session.usage = chosen.usage;
		session.cwd = chosen.cwd;
		// Context-size signal belongs to the session being resumed — leaving the
		// old session's value here feeds shouldCompact a foreign context size.
		session.lastPromptTokens = chosen.lastPromptTokens;
		// Mode travels with the session: restore what the resumed session was
		// left in instead of carrying over the current one.
		deps.setPlanMode(chosen.mode === "plan");
		let contextFilesSuffix: string | undefined;
		let rulesSuffix: string | undefined;
		let rulesLazySuffix: string | undefined;
		let skillsPromptSuffix: string | undefined;
		if (chosen.cwd && chosen.cwd !== deps.cwd) {
			deps.setCwd(chosen.cwd);
			const trusted = await resolveProjectTrustForCwd(deps.projectDeps, chosen.cwd);
			deps.setProjectTrusted(trusted);
			const resolved = await resolveSkillsForCwd(deps.projectDeps, chosen.cwd, trusted);
			deps.setSkills(resolved.skills);
			skillsPromptSuffix = resolved.skillsPromptSuffix;
			deps.setSkillsPromptSuffix(skillsPromptSuffix);
			contextFilesSuffix = formatContextFilesForPrompt(loadProjectContextFiles(chosen.cwd, trusted));
			deps.setContextFilesSuffix(contextFilesSuffix);
			const resolvedRules = resolveRulesForCwd(chosen.cwd, trusted);
			rulesSuffix = resolvedRules.alwaysApplySuffix;
			rulesLazySuffix = resolvedRules.lazySuffix;
			deps.setRulesSuffix(rulesSuffix);
			deps.setRulesLazySuffix(rulesLazySuffix);
			deps.setDirectoryRules(resolvedRules.directoryRules);
			const newPersonaOpts = personaOptionsForCwd(chosen.cwd, trusted);
			deps.setPersonaOptions(newPersonaOpts);
			await closeMcpConnections(deps.mcpResult.connections);
			deps.setMcpResult(
				await resolveMcpForCwd(deps.projectDeps, chosen.cwd, trusted, loadSettings().disabledMcpServers ?? []),
			);
		}
		rebuildSystemPrompt(deps, chosen.cwd || deps.cwd, {
			contextFilesSuffix,
			rulesSuffix,
			rulesLazySuffix,
			skillsPromptSuffix,
		});
		agent.refresh();
		showNotice(`[Switched to session: ${session.id} (${session.messages.length} messages)]`);
		return;
	}

	if (input === "/rules" || input === "/rules list") {
		deps.agent.addDisplayMessage({ role: "user", content: input });
		if (deps.directoryRules.length === 0) {
			deps.agent.addDisplayMessage({
				role: "warning",
				content: "No rules loaded. Create .cast/rules/*.md files to add rules.",
			});
		} else {
			const stickyIds = new Set(deps.activeAutoRules.map((r) => r.id));
			const lines = deps.directoryRules.map((r) => {
				let tag: string;
				if (r.applyMode === "always") {
					tag = " [always]";
				} else if (r.applyMode === "auto") {
					tag = stickyIds.has(r.id) ? " [auto:sticky]" : " [auto:globs]";
				} else if (r.applyMode === "lazy") {
					tag = " [lazy]";
				} else {
					tag = " [manual]";
				}
				const globs = r.globs.length > 0 ? ` globs=${JSON.stringify(r.globs)}` : "";
				const scope = r.scope ? ` scope=${r.scope}` : "";
				return `  ${r.id}${tag}${globs}${scope} (${r.source}) — ${r.description || "no description"}`;
			});
			deps.agent.addDisplayMessage({ role: "warning", content: `Rules\n${lines.join("\n")}` });
		}
		return;
	}

	if (input === "/repo") {
		let isGit = false;
		let branch = "—";
		let dirty = "—";
		let remote = "—";
		let head = "—";
		try {
			execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
				cwd: deps.cwd,
				encoding: "utf8",
				timeout: 3000,
				stdio: ["pipe", "pipe", "pipe"],
			});
			isGit = true;
			branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
				cwd: deps.cwd,
				encoding: "utf8",
				timeout: 3000,
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
			const status = execFileSync("git", ["status", "--porcelain"], {
				cwd: deps.cwd,
				encoding: "utf8",
				timeout: 3000,
				stdio: ["pipe", "pipe", "pipe"],
			});
			dirty = status.trim() ? "true" : "false";
			try {
				remote = execFileSync("git", ["remote", "get-url", "origin"], {
					cwd: deps.cwd,
					encoding: "utf8",
					timeout: 3000,
					stdio: ["pipe", "pipe", "pipe"],
				}).trim();
			} catch {
				// no remote
			}
			const log = execFileSync("git", ["log", "-1", "--pretty=%h %s"], {
				cwd: deps.cwd,
				encoding: "utf8",
				timeout: 3000,
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
			if (log) head = log;
		} catch {
			// not a git repo
		}
		deps.agent.addDisplayMessage({ role: "user", content: input });
		deps.agent.addDisplayMessage({
			role: "warning",
			content: `cwd: ${deps.cwd}\ngit: ${isGit}\ngit branch: ${branch}\ndirty: ${dirty}\nremote: ${remote}\nhead: ${head}`,
		});
		return;
	}

	if (input === "/help") {
		deps.agent.addDisplayMessage({ role: "user", content: input });
		deps.agent.addDisplayMessage({
			role: "warning",
			content:
				"Commands\n" +
				"  /build              Exit plan mode, restore full toolset\n" +
				"  /copy               Copy last assistant response\n" +
				"  /current            Show all status bar data\n" +
				"  /clear              Clear context\n" +
				"  /compact            Compact context now\n" +
				"  /new                Start new session\n" +
				"  /plan               Enter plan mode (explore + plan only)\n" +
				"  /plan-model [m|off] Show or change the plan-mode model\n" +
				"  /abort              Abort running agent (alias: /stop)\n" +
				"  /queue (/q)         Queue message for next turn\n" +
				"  /queue-reset (/qr)  Clear queue\n" +
				"  /steer (/s)         Inject message into running turn\n" +
				"  /model [name]       Show/change model\n" +
				"  /subagent-model [name]  Show/change subagent model\n" +
				"  /reasoning [level]  Show/change reasoning level\n" +
				"  /persona [name]     Show/change persona\n" +
				"  /skills …           Toggle / list / enable|disable / uninstall (/skills help)\n" +
				"  /plugin …           Plugins palette (install / marketplace / toggle)\n" +
				"  /mcp …              Toggle / list / enable|disable / uninstall (/mcp help)\n" +
				"  /reload             Re-scan skills, MCP, rules\n" +
				"  /skill:<name>       Invoke a skill\n" +
				"  /rule:<name>        Invoke a rule\n" +
				"  /provider [name]    Switch / add / delete providers\n" +
				"  /permissions        Change bash confirmation mode\n" +
				"  /web                Toggle web tools (web_search, web_fetch)\n" +
				"  /ssh                Manage SSH hosts (list, add, remove)\n" +
				"  /statusbar          Toggle and reorder status bar segments\n" +
				"  /theme              Change color theme\n" +
				"  /usage              Show session token/cost usage\n" +
				"  /sessions           List/switch sessions\n" +
				"  /rules              List loaded rules\n" +
				"  /repo               Show cwd and git branch\n" +
				"  /keys               List keybindings\n" +
				"  /quit               Save and exit (alias: /exit)",
		});
		return;
	}

	if (input.startsWith("/rule:")) {
		const ruleName = input.slice("/rule:".length).trim();
		if (!ruleName) {
			showNotice("[Usage: /rule:<name>]");
			return;
		}
		// Prefer an exact id match (scope-qualified, e.g. apps/web/style), then
		// fall back to the bare name (first match) for the common flat case.
		const rule =
			deps.directoryRules.find((r) => r.id === ruleName) ?? deps.directoryRules.find((r) => r.name === ruleName);
		if (!rule) {
			showNotice(`[No rule named "${ruleName}". Use /rules to list available.]`);
			return;
		}
		await agent.submit(formatRuleInvocation(rule));
		return;
	}

	if (input === "/keys") {
		deps.agent.addDisplayMessage({ role: "user", content: input });
		const ACTION_LABELS: Record<string, string> = {
			"editor.cursorUp": "Cursor up",
			"editor.cursorDown": "Cursor down",
			"editor.cursorLeft": "Cursor left",
			"editor.cursorRight": "Cursor right",
			"editor.cursorWordLeft": "Word left",
			"editor.cursorWordRight": "Word right",
			"editor.cursorLineStart": "Line start",
			"editor.cursorLineEnd": "Line end",
			"editor.deleteCharBackward": "Delete char",
			"editor.deleteCharForward": "Delete forward",
			"editor.deleteWordBackward": "Delete word",
			"editor.deleteWordForward": "Delete word forward",
			"editor.deleteToLineStart": "Delete to line start",
			"editor.deleteToLineEnd": "Delete to line end",
			"input.newLine": "New line",
			"input.submit": "Submit",
			"input.abort": "Exit (2× to confirm)",
			"input.escape": "Stop turn / clear input",
			"input.attachImage": "Attach image",
			"input.tab": "Autocomplete",
		};
		const KEY_LABELS: Record<string, string> = {
			up: "↑",
			down: "↓",
			left: "←",
			right: "→",
			enter: "Enter",
			backspace: "Backspace",
			delete: "Del",
			escape: "Esc",
			tab: "Tab",
			home: "Home",
			end: "End",
			"ctrl+c": "Ctrl+C",
			"ctrl+d": "Ctrl+D",
			"ctrl+w": "Ctrl+W",
			"ctrl+u": "Ctrl+U",
			"ctrl+k": "Ctrl+K",
			"ctrl+b": "Ctrl+B",
			"ctrl+f": "Ctrl+F",
			"ctrl+a": "Ctrl+A",
			"ctrl+e": "Ctrl+E",
			"ctrl+j": "Ctrl+J",
			"ctrl+g": "Ctrl+G",
			"alt+b": "Alt+B",
			"alt+f": "Alt+F",
			"alt+d": "Alt+D",
			"alt+left": "Alt+←",
			"alt+right": "Alt+→",
			"alt+backspace": "Alt+Backspace",
			"alt+delete": "Alt+Del",
			"alt+enter": "Alt+Enter",
			"ctrl+left": "Ctrl+←",
			"ctrl+right": "Ctrl+→",
			"shift+enter": "Shift+Enter",
		};
		const lines = Object.entries(TUI_KEYBINDINGS).map(([id, def]) => {
			const label = ACTION_LABELS[id] ?? id;
			const rawKeys = Array.isArray(def.defaultKeys) ? def.defaultKeys : [def.defaultKeys];
			const keys = rawKeys.map((k) => KEY_LABELS[k] ?? k).join(" / ");
			return `  ${label.padEnd(22)} ${keys}`;
		});
		const header = "Keybindings";
		// Esc and Ctrl+C are context-dependent (a single label can't capture it):
		// spell out what each does while a turn is running vs idle.
		const notes =
			"\n\n  Esc      stops the current turn while generating; clears the input otherwise" +
			"\n  Ctrl+C   press twice within 2s to exit (does not stop a turn — use Esc for that)";
		deps.agent.addDisplayMessage({
			role: "warning",
			content: `${header}\n${lines.join("\n")}${notes}`,
		});
		return;
	}

	// Unknown slash command — submit to agent as regular text (could be a
	// file path starting with /, e.g. /tmp/cast-clipboard-UUID.png).
	await agent.submit(text);
}
