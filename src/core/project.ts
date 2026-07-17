import { existsSync, readdirSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import { resolveProjectTrust } from "../pickers/domain.ts";
import type { Pickers } from "../pickers/types.ts";
import { hasContextFileInDir } from "./context-files.ts";
import { connectMcpServers, loadMcpConfig, type McpServerConfig, type McpSetupResult } from "./mcp.ts";
import { globalPersonasDir, type LoadPersonasOptions, loadPersonas, type Persona } from "./personas.ts";
import {
	formatAlwaysApplyRules,
	formatLazyRulesForPrompt,
	globalRulesDir,
	hasProjectRulesDir,
	loadDirectoryRules,
	type Rule,
} from "./rules.ts";
import type { PermissionMode, Settings } from "./settings.ts";
import { builtinSkillsDir, formatSkillsForPrompt, loadSkills, type Skill } from "./skills.ts";
import { loadSshConfig, projectSshPath } from "./ssh.ts";

export interface ProjectResolverDeps {
	noSkills: boolean;
	noMcp: boolean;
	cliSkillPaths: string[];
	cliMcpPaths: string[];
	settings: Settings;
	pickers: Pickers;
}

const globalSkillsDir = join(homedir(), ".cast", "skills");
const globalMcpPath = join(homedir(), ".cast", "mcp.json");

function projectSkillsDir(targetCwd: string): string | undefined {
	const dir = join(targetCwd, ".cast", "skills");
	return dir !== globalSkillsDir ? dir : undefined;
}

function projectMcpPath(targetCwd: string): string | undefined {
	const path = join(targetCwd, ".cast", "mcp.json");
	return path !== globalMcpPath ? path : undefined;
}

function projectPersonasDir(targetCwd: string): string | undefined {
	const dir = join(targetCwd, ".cast", "personas");
	return dir !== globalPersonasDir ? dir : undefined;
}

/** True if `<cwd>/.cast/personas/` exists and contains at least one .md file. */
function hasProjectPersonas(targetCwd: string): boolean {
	const dir = projectPersonasDir(targetCwd);
	if (!dir || !existsSync(dir)) return false;
	try {
		return readdirSync(dir).some((f) => f.endsWith(".md"));
	} catch {
		return false;
	}
}

/**
 * Single trust gate for skills, MCP servers, context files, and rules — all
 * project-local resources that could come from a cloned repository. Cached
 * per-cwd in settings.json. Used both at startup (runStartup) and mid-session
 * (/sessions switching cwd, /reload re-scanning the current cwd).
 */
export async function resolveProjectTrustForCwd(deps: ProjectResolverDeps, cwd: string): Promise<boolean> {
	const lines: string[] = [];
	const skillsDir = projectSkillsDir(cwd);
	if (!deps.noSkills && skillsDir && existsSync(skillsDir))
		lines.push("  - .cast/skills/ (agent skills — can instruct the model to run commands)");
	const mcpPath = projectMcpPath(cwd);
	if (!deps.noMcp && mcpPath && existsSync(mcpPath)) {
		const names = Object.keys(loadMcpConfig(mcpPath));
		if (names.length > 0) {
			lines.push("  - .cast/mcp.json (MCP servers — spawned as real processes)");
			for (const name of names) lines.push(`      ${name}`);
		}
	}
	if (hasContextFileInDir(cwd)) lines.push("  - AGENTS.md / CLAUDE.md (project instructions for the system prompt)");
	if (hasProjectRulesDir(cwd)) lines.push("  - .cast/rules/ (project rules — always-apply, lazy, or manual)");
	if (hasProjectPersonas(cwd)) lines.push("  - .cast/personas/ (custom personas — system prompts for the agent)");
	const sshPath = projectSshPath(cwd);
	if (existsSync(sshPath)) {
		const hosts = Object.keys(loadSshConfig(sshPath));
		if (hosts.length > 0) {
			lines.push("  - .cast/ssh.json (SSH hosts — remote command execution)");
			for (const name of hosts) lines.push(`      ${name}`);
		}
	}
	if (lines.length === 0) return true;
	return resolveProjectTrust(deps.pickers, deps.settings, cwd, lines);
}

export async function resolveSkillsForCwd(
	deps: ProjectResolverDeps,
	cwd: string,
	trusted: boolean,
): Promise<{ skills: Skill[]; skillsPromptSuffix: string }> {
	const skillsDir = projectSkillsDir(cwd);
	const skillsResult = loadSkills({
		globalDir: deps.noSkills ? undefined : globalSkillsDir,
		builtinDir: deps.noSkills ? undefined : builtinSkillsDir,
		projectDir: trusted && skillsDir && existsSync(skillsDir) ? skillsDir : undefined,
		extraPaths: deps.cliSkillPaths,
	});
	for (const diagnostic of skillsResult.diagnostics) {
		console.log(`[skill warning] ${diagnostic.path}: ${diagnostic.message}`);
	}
	return {
		skills: skillsResult.skills,
		skillsPromptSuffix: formatSkillsForPrompt(skillsResult.skills),
	};
}

export async function resolveMcpForCwd(
	deps: ProjectResolverDeps,
	cwd: string,
	trusted: boolean,
	disabledServers: string[] = [],
): Promise<McpSetupResult> {
	const emptyResult = {
		toolIndex: new Map(),
		toolDefinitions: [],
		connections: [],
		diagnostics: [],
		allServerNames: [] as string[],
	};
	if (deps.noMcp) return emptyResult;
	const globalServers = loadMcpConfig(globalMcpPath);
	let projectServers: Record<string, McpServerConfig> = {};
	const mcpPath = projectMcpPath(cwd);
	if (trusted && mcpPath && existsSync(mcpPath)) {
		projectServers = loadMcpConfig(mcpPath);
	}
	const extraServers: Record<string, McpServerConfig> = {};
	for (const path of deps.cliMcpPaths) Object.assign(extraServers, loadMcpConfig(path));
	const merged = { ...globalServers, ...projectServers, ...extraServers };
	const allNames = Object.keys(merged);
	if (allNames.length === 0) return { ...emptyResult, allServerNames: [] };
	// Filter out disabled servers before connecting
	const disabledSet = new Set(disabledServers);
	const filtered = Object.fromEntries(Object.entries(merged).filter(([name]) => !disabledSet.has(name)));
	const result = await connectMcpServers(filtered);
	result.allServerNames = allNames;
	for (const diagnostic of result.diagnostics) console.log(`[mcp warning] ${diagnostic}`);
	return result;
}

/** Assemble the full system prompt from persona + project suffixes + cwd/date. */
export function personaOptionsForCwd(cwd: string, trusted: boolean): LoadPersonasOptions {
	return {
		globalDir: globalPersonasDir,
		projectDir: trusted ? projectPersonasDir(cwd) : undefined,
	};
}

/**
 * Load and merge personas from builtin + global + project. Returns the full
 * list and the options used, so callers can pass them to findPersona later.
 */
export function resolvePersonasForCwd(
	cwd: string,
	trusted: boolean,
): { personas: Persona[]; options: LoadPersonasOptions } {
	const options = personaOptionsForCwd(cwd, trusted);
	return { personas: loadPersonas(options), options };
}

export interface ResolvedRules {
	/** Always-apply directory rules, formatted for prompt injection. */
	alwaysApplySuffix: string;
	/** Lazy (description-only) directory rules, formatted for prompt. */
	lazySuffix: string;
	/** All discovered directory rules (for /rule:name lookup). */
	directoryRules: Rule[];
}

export function resolveRulesForCwd(cwd: string, trusted: boolean): ResolvedRules {
	// When trusted, discover the root `.cast/rules` plus any nested ones in
	// subdirectories (each scoped to its subtree). Global rules always load.
	const directoryRules = loadDirectoryRules({
		globalDir: globalRulesDir(),
		projectCwd: trusted ? cwd : undefined,
	});

	return {
		alwaysApplySuffix: formatAlwaysApplyRules(directoryRules),
		lazySuffix: formatLazyRulesForPrompt(directoryRules),
		directoryRules,
	};
}

// One line telling the model what OS it's driving, so it picks the right
// commands and path conventions. The bash tool always spawns `bash -c` (on
// Windows that means Git Bash), so the syntax hint stays POSIX everywhere —
// what changes per platform is the OS toolchain and path conventions around it.
const PLATFORM_NAMES: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };
const PLATFORM_LINE = `${platform()}${PLATFORM_NAMES[platform()] ? ` (${PLATFORM_NAMES[platform()]})` : ""}, ${arch()}${
	platform() === "win32" ? " — the bash tool runs commands via Git Bash, use POSIX syntax" : ""
}`;

function localDateString(now = new Date()): string {
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * Rules + skills prompt suffixes for a cwd — same discovery the parent session
 * uses (global + builtin + trusted project). Used so task subagents see the
 * same project grounding without re-threading startup deps.
 */
export function resolvePromptContextForCwd(
	cwd: string,
	trusted: boolean,
): { rulesSuffix: string; rulesLazySuffix: string; skillsPromptSuffix: string } {
	const rules = resolveRulesForCwd(cwd, trusted);
	const skillsDir = projectSkillsDir(cwd);
	const skillsResult = loadSkills({
		globalDir: globalSkillsDir,
		builtinDir: builtinSkillsDir,
		projectDir: trusted && skillsDir && existsSync(skillsDir) ? skillsDir : undefined,
		extraPaths: [],
	});
	return {
		rulesSuffix: rules.alwaysApplySuffix,
		rulesLazySuffix: rules.lazySuffix,
		skillsPromptSuffix: formatSkillsForPrompt(skillsResult.skills),
	};
}

export interface SystemEnvironmentOptions {
	model: string;
	reasoningLevel: string;
	reasoningMeta?: { supportedEfforts: string[] } | null;
	/** Agent mode. TUI-only — headless runs omit it. */
	mode?: "plan" | "build";
	persona?: Persona;
	/** When set, labels a task subagent instead of the parent persona. */
	subagent?: { name: string; label: string };
}

/**
 * Environment grounding (cwd / date / platform / model). Shared by the parent
 * system prompt and sync `task` subagents so children know which directory
 * relative tool paths resolve against.
 */
export function formatSystemEnvironmentBlock(cwd: string, options?: SystemEnvironmentOptions): string {
	const date = localDateString();
	if (!options) {
		return `\nCurrent date: ${date}\nCurrent working directory: ${cwd}\nPlatform: ${PLATFORM_LINE}\n`;
	}

	const lines: Array<string | null> = [
		"",
		"",
		"## Current System State",
		`- Current date: ${date}`,
		`- Current working directory: ${cwd}`,
		`- Platform: ${PLATFORM_LINE}`,
		`- Model: ${options.model}`,
		`- Reasoning: ${options.reasoningLevel}`,
	];

	if (options.subagent) {
		lines.push(`- Subagent: ${options.subagent.name} (${options.subagent.label})`);
		// Tools resolve against LoopConfig.cwd; say so explicitly — children
		// previously only had the role prompt and often invented wrong roots.
		lines.push("- Tool paths are relative to the current working directory above.");
	} else {
		if (options.mode === "plan") {
			lines.push(
				"- Mode: plan — read-only exploration and planning; plan_done opens the approval dialog, or the user exits with the /build command",
			);
		} else if (options.mode === "build") {
			lines.push(
				"- Mode: build — full toolset; for a complex task worth planning first, suggest it with the plan_enter tool (the user can also enter plan mode with the /plan command)",
			);
		}
		if (options.reasoningMeta?.supportedEfforts?.length) {
			lines.push(`- Supported reasoning efforts: ${options.reasoningMeta.supportedEfforts.join(", ")}`);
		}
		if (options.persona) {
			lines.push(`- Persona: ${options.persona.name} (${options.persona.label})`);
			if (options.persona.filePath) lines.push(`- Persona file: ${options.persona.filePath}`);
			lines.push(`- Persona source: ${options.persona.source}`);
		}
	}

	return `${lines.filter((l): l is string => l !== null).join("\n")}\n`;
}

export function buildSystemPrompt(
	persona: Persona,
	contextFilesSuffix: string,
	rulesSuffix: string,
	rulesLazySuffix: string,
	skillsPromptSuffix: string,
	mcpPromptSuffix: string,
	cwd: string,
	state?: {
		model: string;
		reasoningLevel: string;
		reasoningMeta?: { supportedEfforts: string[] } | null;
		/** Agent mode. TUI-only — headless runs have no modes, so they omit it
		 * and the Mode line (with its /plan and /build hints) never renders there. */
		mode?: "plan" | "build";
	},
): string {
	const stateBlock = state
		? formatSystemEnvironmentBlock(cwd, {
				model: state.model,
				reasoningLevel: state.reasoningLevel,
				reasoningMeta: state.reasoningMeta,
				mode: state.mode,
				persona,
			})
		: formatSystemEnvironmentBlock(cwd);

	return [
		persona.systemPrompt,
		persona.agentsMd ? contextFilesSuffix : "",
		rulesSuffix,
		rulesLazySuffix,
		skillsPromptSuffix,
		mcpPromptSuffix,
		stateBlock,
	]
		.filter(Boolean)
		.join("");
}

/**
 * Dangerous-bash confirmation gate. "bypass" mode and non-TTY contexts short-
 * circuit without prompting; otherwise the picker offers an Allow/Block choice.
 * Recreated by callers whenever permissionMode changes so the closure never
 * goes stale.
 */
export function makeConfirmBash(
	pickers: Pickers,
	permissionMode: PermissionMode,
): (command: string, reason: string) => Promise<boolean> {
	return async (command, reason) => {
		if (permissionMode === "bypass") return true;
		if (!process.stdin.isTTY) {
			console.log(
				`\n\x1b[31m[Blocked: command looks dangerous (${reason}) and can't be confirmed non-interactively.]\x1b[0m`,
			);
			console.log("Run interactively to confirm it, or use /permissions bypass beforehand.");
			return false;
		}
		pickers.log(`Dangerous command: ${reason}\n  ${command}`);
		const picked = await pickers.pickOption(
			[
				{ value: true, label: "Allow once" },
				{ value: false, label: "Block" },
			],
			{ title: "Allow this command?" },
		);
		return picked === true;
	};
}
