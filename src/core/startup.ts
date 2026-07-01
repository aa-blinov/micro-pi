import { existsSync } from "node:fs";
import {
	resolveConnection,
	selectModel,
	selectPersona,
	selectReasoningLevel,
	selectSession,
	tryCliModel,
} from "../pickers/domain.ts";
import type { Pickers } from "../pickers/types.ts";
import { type AppConfig, fetchModels, loadConfig, runOnboardingCheck } from "./config.ts";
import { formatContextFilesForPrompt, loadProjectContextFiles } from "./context-files.ts";
import type { McpSetupResult } from "./mcp.ts";
import { findPersona, listPersonas, type Persona } from "./personas.ts";
import {
	buildSystemPrompt,
	makeConfirmBash,
	type ProjectResolverDeps,
	resolveMcpForCwd,
	resolveProjectTrustForCwd,
	resolveSkillsForCwd,
} from "./project.ts";
import { setModelsCache } from "./readline.ts";
import { formatRulesForPrompt, loadRules } from "./rules.ts";
import { type AgentRunner, createAgentRunner } from "./runner.ts";
import { createSession, getMostRecentSession, loadSession, type SessionState } from "./session.ts";
import { type PermissionMode, type Settings, updateSettings } from "./settings.ts";
import type { Skill } from "./skills.ts";
import { buildReasoningParams, type ModelReasoningMeta } from "./vendors.ts";

export interface ParsedArgs {
	cwd: string;
	settings: Settings;
	cliModel?: string;
	cliReasoning?: string;
	cliPersona?: string;
	initialPrompt?: string;
	resumeRequested: boolean;
	resumeId?: string;
	resumePicker: boolean;
	cliBypassPermissions: boolean;
	noSkills: boolean;
	cliSkillPaths: string[];
	noMcp: boolean;
	cliMcpPaths: string[];
	version: string;
}

export interface StartupResult {
	config: AppConfig;
	cwd: string;
	systemPrompt: string;
	session: SessionState;
	runner: AgentRunner;
	permissionMode: PermissionMode;
	mcpResult: McpSetupResult;
	skills: Skill[];
	persona: Persona;
	reasoningMeta?: ModelReasoningMeta;
	confirmBash: (command: string, reason: string) => Promise<boolean>;
	projectDeps: ProjectResolverDeps;
	projectTrusted: boolean;
	contextFilesSuffix: string;
	rulesSuffix: string;
	skillsPromptSuffix: string;
	resumed: boolean;
}

/**
 * Background-fetch /v1/models to backfill reasoningMeta and the model's real
 * context window. Both the --model and reuse-saved-model fast paths validate
 * with a raw chat completion (not /v1/models), so neither has the metadata on
 * hand — this keeps the fast path fast while still fixing shouldCompact using
 * a hardcoded 128k default.
 */
function warmModelMetadataInBackground(config: AppConfig, forModel: string): Promise<void> | undefined {
	return fetchModels(config)
		.then((r) => {
			if (!r.ok || !r.models) return;
			setModelsCache(r.models);
			const found = r.models.find((m) => m.id === forModel);
			if (found?.contextWindow && found.contextWindow > 0) config.contextWindow = found.contextWindow;
		})
		.catch(() => {});
}

/**
 * Single entry point for everything between arg parsing and the UI taking
 * over: provider connection, model/persona/reasoning resolution, project
 * trust + skills + MCP setup, session resume, runner creation, and the
 * dangerous-bash confirm callback. Both `index.ts` (basic) and `tui.tsx`
 * call this — neither duplicates onboarding logic anymore.
 *
 * @param onProgress Optional status callback for the silent stretches (fast-
 * path model re-validation, MCP server handshakes) that otherwise leave the
 * TUI showing nothing at all for a few seconds before the first frame — see
 * tui.tsx's startup loader. Pickers already have their own visible UI, so
 * this only fires around the parts that don't.
 */
export async function runStartup(
	args: ParsedArgs,
	pickers: Pickers,
	onProgress?: (text: string) => void,
): Promise<StartupResult> {
	const { settings } = args;
	let cwd = args.cwd;
	const permissionMode: PermissionMode = args.cliBypassPermissions ? "bypass" : (settings.permissionMode ?? "default");

	const projectDeps: ProjectResolverDeps = {
		noSkills: args.noSkills,
		noMcp: args.noMcp,
		cliSkillPaths: args.cliSkillPaths,
		cliMcpPaths: args.cliMcpPaths,
		settings,
		pickers,
	};

	onProgress?.("Loading project settings...");
	const projectTrusted = await resolveProjectTrustForCwd(projectDeps, cwd);
	const { skills, skillsPromptSuffix } = await resolveSkillsForCwd(projectDeps, cwd, projectTrusted);
	const contextFilesSuffix = formatContextFilesForPrompt(loadProjectContextFiles(cwd, projectTrusted));
	const rulesSuffix = formatRulesForPrompt(loadRules(cwd, projectTrusted));

	// Persona: CLI > saved settings > interactive selection.
	let persona: Persona;
	if (args.cliPersona) {
		const found = findPersona(args.cliPersona);
		if (!found) {
			console.error(
				`Unknown persona "${args.cliPersona}". Available: ${listPersonas()
					.map((p) => p.name)
					.join(", ")}`,
			);
			process.exit(1);
		}
		persona = found;
	} else if (settings.persona) {
		const found = findPersona(settings.persona);
		if (found) {
			persona = found;
		} else {
			console.log(`Saved persona "${settings.persona}" no longer exists.`);
			const selected = await selectPersona(pickers);
			if (!selected) process.exit(0);
			persona = selected;
		}
	} else {
		const selected = await selectPersona(pickers);
		if (!selected) process.exit(0);
		persona = selected;
	}
	updateSettings({ persona: persona.name });

	const { baseURL, apiKey } = await resolveConnection(pickers, settings);
	const config = loadConfig({ baseURL, apiKey });

	// Model: CLI > saved > interactive.
	let model: string;
	let reasoningMeta: ModelReasoningMeta | undefined;
	let contextWindow: number | undefined;

	if (args.cliModel) {
		onProgress?.("Connecting to model...");
		const selection = await tryCliModel(config, args.cliModel);
		if (selection) {
			model = selection.model;
			reasoningMeta = selection.reasoningMeta;
			contextWindow = selection.contextWindow;
			const p = warmModelMetadataInBackground(config, model);
			if (p) await p;
		} else {
			const sel = await selectModel(config, pickers);
			if (!sel) process.exit(0);
			model = sel.model;
			reasoningMeta = sel.reasoningMeta;
			contextWindow = sel.contextWindow;
		}
	} else if (settings.model) {
		onProgress?.("Connecting to model...");
		const ok = await runOnboardingCheck(config, settings.model, { silent: true });
		if (ok) {
			model = settings.model;
			const p = warmModelMetadataInBackground(config, model);
			if (p) await p;
		} else {
			console.log("failed, selecting new model");
			const sel = await selectModel(config, pickers);
			if (!sel) process.exit(0);
			model = sel.model;
			reasoningMeta = sel.reasoningMeta;
			contextWindow = sel.contextWindow;
		}
	} else {
		const sel = await selectModel(config, pickers);
		if (!sel) process.exit(0);
		model = sel.model;
		reasoningMeta = sel.reasoningMeta;
		contextWindow = sel.contextWindow;
	}

	if (contextWindow && contextWindow > 0) config.contextWindow = contextWindow;

	// Reasoning: CLI > saved (same model) > interactive.
	if (args.cliReasoning) {
		config.reasoningLevel = args.cliReasoning;
		config.reasoningParams = buildReasoningParams(args.cliReasoning);
	} else if (settings.reasoningLevel && settings.model === model) {
		config.reasoningLevel = settings.reasoningLevel;
		config.reasoningParams = buildReasoningParams(settings.reasoningLevel);
	} else {
		await selectReasoningLevel(config, model, pickers, reasoningMeta);
	}

	updateSettings({
		model,
		reasoningLevel: config.reasoningLevel,
		providerUrl: baseURL,
		apiKey,
		cwd,
	});

	// Session resume.
	let resumedSession: SessionState | undefined;
	if (args.resumeRequested) {
		let found: SessionState | null;
		if (args.resumeId) {
			found = loadSession(args.resumeId);
		} else if (args.resumePicker && process.stdin.isTTY) {
			found = await selectSession(pickers);
		} else {
			found = getMostRecentSession();
		}
		if (found) {
			resumedSession = found;
			if (!args.cliModel) model = found.model;
			if (found.cwd && found.cwd !== cwd && existsSync(found.cwd)) {
				cwd = found.cwd;
			}
		} else if (args.resumeId) {
			console.error(`No saved session found with id "${args.resumeId}".`);
		}
	}

	const session = resumedSession ? { ...resumedSession, model } : createSession(model, cwd);
	const runner = createAgentRunner();
	const systemPrompt = buildSystemPrompt(persona, contextFilesSuffix, rulesSuffix, skillsPromptSuffix, cwd);
	onProgress?.("Connecting MCP servers...");
	const mcpResult = await resolveMcpForCwd(projectDeps, cwd, projectTrusted);
	const confirmBash = makeConfirmBash(pickers, permissionMode);

	return {
		config,
		cwd,
		systemPrompt,
		session,
		runner,
		permissionMode,
		mcpResult,
		skills,
		persona,
		reasoningMeta,
		confirmBash,
		projectDeps,
		projectTrusted,
		contextFilesSuffix,
		rulesSuffix,
		skillsPromptSuffix,
		resumed: !!resumedSession,
	};
}
