import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectTrust } from "../pickers/domain.ts";
import type { Pickers } from "../pickers/types.ts";
import { hasContextFileInDir } from "./context-files.ts";
import { connectMcpServers, loadMcpConfig, type McpServerConfig, type McpSetupResult } from "./mcp.ts";
import type { Persona } from "./personas.ts";
import { hasProjectRules } from "./rules.ts";
import type { PermissionMode, Settings } from "./settings.ts";
import { formatSkillsForPrompt, loadSkills, type Skill } from "./skills.ts";

export interface ProjectResolverDeps {
	noSkills: boolean;
	noMcp: boolean;
	cliSkillPaths: string[];
	cliMcpPaths: string[];
	settings: Settings;
	pickers: Pickers;
}

const globalSkillsDir = join(process.env.HOME ?? ".", ".cast", "skills");
const globalMcpPath = join(process.env.HOME ?? ".", ".cast", "mcp.json");

function projectSkillsDir(targetCwd: string): string | undefined {
	const dir = join(targetCwd, ".cast", "skills");
	return dir !== globalSkillsDir ? dir : undefined;
}

function projectMcpPath(targetCwd: string): string | undefined {
	const path = join(targetCwd, ".cast", "mcp.json");
	return path !== globalMcpPath ? path : undefined;
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
	if (hasProjectRules(cwd)) lines.push("  - .cast/rules.md (user instructions appended to the system prompt)");
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
): Promise<McpSetupResult> {
	if (deps.noMcp) return { toolIndex: new Map(), toolDefinitions: [], connections: [], diagnostics: [] };
	const globalServers = loadMcpConfig(globalMcpPath);
	let projectServers: Record<string, McpServerConfig> = {};
	const mcpPath = projectMcpPath(cwd);
	if (trusted && mcpPath && existsSync(mcpPath)) {
		projectServers = loadMcpConfig(mcpPath);
	}
	const extraServers: Record<string, McpServerConfig> = {};
	for (const path of deps.cliMcpPaths) Object.assign(extraServers, loadMcpConfig(path));
	const merged = { ...globalServers, ...projectServers, ...extraServers };
	if (Object.keys(merged).length === 0)
		return { toolIndex: new Map(), toolDefinitions: [], connections: [], diagnostics: [] };
	const result = await connectMcpServers(merged);
	for (const diagnostic of result.diagnostics) console.log(`[mcp warning] ${diagnostic}`);
	return result;
}

/** Assemble the full system prompt from persona + project suffixes + cwd/date. */
export function buildSystemPrompt(
	persona: Persona,
	contextFilesSuffix: string,
	rulesSuffix: string,
	skillsPromptSuffix: string,
	cwd: string,
): string {
	const now = new Date();
	const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	return [
		persona.systemPrompt,
		contextFilesSuffix,
		rulesSuffix,
		skillsPromptSuffix,
		`\nCurrent date: ${date}`,
		`Current working directory: ${cwd}`,
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
