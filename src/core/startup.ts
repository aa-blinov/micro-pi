import { existsSync } from "node:fs";
import {
	reconfigureConnection,
	resolveConnection,
	selectModel,
	selectPersona,
	selectReasoningLevel,
	selectSession,
	tryCliModel,
} from "../pickers/domain.ts";
import type { Pickers } from "../pickers/types.ts";
import {
	type AppConfig,
	fetchModels,
	loadConfig,
	lookupContextWindow,
	type ProviderProbe,
	probeProvider,
	runOnboardingCheck,
} from "./config.ts";
import { formatContextFilesForPrompt, loadProjectContextFiles } from "./context-files.ts";
import type { McpSetupResult } from "./mcp.ts";
import { findPersona, type LoadPersonasOptions, listPersonas, type Persona } from "./personas.ts";
import {
	buildSystemPrompt,
	makeConfirmBash,
	type ProjectResolverDeps,
	personaOptionsForCwd,
	resolveMcpForCwd,
	resolveProjectTrustForCwd,
	resolveRulesForCwd,
	resolveSkillsForCwd,
} from "./project.ts";
import { setModelsCache } from "./readline.ts";
import type { Rule } from "./rules.ts";
import { type AgentRunner, createAgentRunner } from "./runner.ts";
import { createSession, getMostRecentSession, loadSession, type SessionState } from "./session.ts";
import { loadSettings, type PermissionMode, type Settings, updateSettings } from "./settings.ts";
import type { Skill } from "./skills.ts";
import type { SshHost } from "./ssh.ts";
import { resolveSshHosts } from "./ssh.ts";
import { loadSubagentPrompts, type SubagentPrompt } from "./subagents.ts";
import { getBashResolution } from "./tools/bash.ts";
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
	personaOptions: LoadPersonasOptions;
	/** All available personas for the task tool. */
	personas: Persona[];
	/** Subagent prompts for the task tool. */
	subagentPrompts: SubagentPrompt[];
	/** Model for subagents (falls back to main model if unset). */
	subagentModel?: string;
	/** Model for plan mode (falls back to main model if unset). */
	planModel?: string;
	reasoningMeta?: ModelReasoningMeta;
	confirmBash: (command: string, reason: string) => Promise<boolean>;
	projectDeps: ProjectResolverDeps;
	projectTrusted: boolean;
	contextFilesSuffix: string;
	rulesSuffix: string;
	rulesLazySuffix: string;
	directoryRules: Rule[];
	activeAutoRules: Rule[];
	skillsPromptSuffix: string;
	/** Configured SSH hosts for the ssh tool. */
	sshHosts: SshHost[];
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

function probeReason(probe: Exclude<ProviderProbe, "ok" | "unknown">, baseURL: string): string {
	if (probe === "auth")
		return "API key rejected — it may be revoked, expired, or wrong. Enter new provider credentials.";
	if (probe === "permission") return "API key lacks permission for this endpoint. Enter new provider credentials.";
	return `Cannot reach ${baseURL}. Enter the provider URL and API key again.`;
}

/**
 * Called on a startup failure path (saved/CLI model didn't validate) before
 * falling through to model selection. Probes the provider: if the connection
 * itself is dead (revoked key, dead endpoint), re-prompts credentials in place
 * and loops until it's live — otherwise a revoked-key user lands in a model
 * picker that can never succeed, since no id validates against a rejected key.
 * A reachable-but-unclassifiable provider ("unknown", e.g. one without
 * /v1/models) is left alone so we don't nag on a false positive. Mutates
 * config + persists new creds (mirroring /provider). Exits if the user cancels.
 *
 * Returns true if credentials were actually changed — a new token may belong to
 * a different account/provider whose model set differs, so the caller re-picks
 * the model rather than reusing the saved one.
 */
export async function ensureConnectionAlive(config: AppConfig, pickers: Pickers): Promise<boolean> {
	let changed = false;
	while (true) {
		const probe = await probeProvider(config);
		if (probe === "ok" || probe === "unknown") return changed;
		const creds = await reconfigureConnection(
			pickers,
			{ baseURL: config.baseURL, apiKey: config.apiKey },
			probeReason(probe, config.baseURL),
		);
		if (!creds) process.exit(0);
		config.baseURL = creds.baseURL;
		config.apiKey = creds.apiKey;
		// Seed the providers array so /provider can list and switch from the
		// get-go; legacy users with only providerUrl/apiKey set are covered by
		// migrateProviders on read.
		const existing = loadSettings().providers ?? [];
		const providerName = "default";
		const providers = existing.some((p) => p.name === providerName)
			? existing.map((p) =>
					p.name === providerName ? { name: providerName, url: creds.baseURL, apiKey: creds.apiKey } : p,
				)
			: [...existing, { name: providerName, url: creds.baseURL, apiKey: creds.apiKey }];
		updateSettings({ providerUrl: creds.baseURL, apiKey: creds.apiKey, providers });
		changed = true;
	}
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

	// Surface a broken bash resolution (win32 without Git Bash → WSL shim
	// fallback) at startup, where the user actually sees it — the per-call
	// warning inside the first bash result is read mostly by the model.
	const bashResolution = getBashResolution();
	if (bashResolution.warning) pickers.log(`[bash] ${bashResolution.warning}`);

	onProgress?.("Loading project settings...");
	const projectTrusted = await resolveProjectTrustForCwd(projectDeps, cwd);
	const { skills, skillsPromptSuffix } = await resolveSkillsForCwd(projectDeps, cwd, projectTrusted);
	const contextFilesSuffix = formatContextFilesForPrompt(loadProjectContextFiles(cwd, projectTrusted));
	const resolvedRules = resolveRulesForCwd(cwd, projectTrusted);
	const rulesSuffix = resolvedRules.alwaysApplySuffix;
	const rulesLazySuffix = resolvedRules.lazySuffix;
	const personaOpts = personaOptionsForCwd(cwd, projectTrusted);
	const allPersonas = listPersonas(personaOpts);

	// Persona: CLI > saved settings > interactive selection.
	let persona: Persona;
	if (args.cliPersona) {
		const found = findPersona(args.cliPersona, personaOpts);
		if (!found) {
			console.error(
				`Unknown persona "${args.cliPersona}". Available: ${listPersonas(personaOpts)
					.map((p) => p.name)
					.join(", ")}`,
			);
			process.exit(1);
		}
		persona = found;
	} else if (settings.persona) {
		const found = findPersona(settings.persona, personaOpts);
		if (found) {
			persona = found;
		} else {
			console.log(`Saved persona "${settings.persona}" no longer exists.`);
			const selected = await selectPersona(pickers, personaOpts);
			if (!selected) process.exit(0);
			persona = selected;
		}
	} else {
		const selected = await selectPersona(pickers, personaOpts);
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
			// --model failed to validate — same fork as the saved-model path: make
			// sure the connection is actually alive before routing to a model
			// picker that can't help if the key/endpoint is the real problem.
			await ensureConnectionAlive(config, pickers);
			const sel = await selectModel(config, pickers);
			if (!sel) process.exit(0);
			model = sel.model;
			reasoningMeta = sel.reasoningMeta;
			contextWindow = sel.contextWindow;
		}
	} else if (settings.model) {
		onProgress?.("Connecting to model...");
		let ok = await runOnboardingCheck(config, settings.model, { silent: true });
		if (!ok) {
			// The saved model failed — but that might be the *connection* (revoked
			// key, dead endpoint), not the model. Re-prompt credentials if so. If
			// the token actually changed, always re-pick the model (a new token can
			// mean a different account/provider with a different model set); only
			// when the connection was already fine do we re-check and keep the saved
			// model the user never changed.
			const credsChanged = await ensureConnectionAlive(config, pickers);
			if (!credsChanged) ok = await runOnboardingCheck(config, settings.model, { silent: true });
		}
		if (ok) {
			model = settings.model;
			const p = warmModelMetadataInBackground(config, model);
			if (p) await p;
		} else {
			console.log("Saved model unavailable — selecting a new one.");
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
	// Fallback: known model context windows when /v1/models doesn't expose them.
	if (!contextWindow || contextWindow <= 0) {
		const known = lookupContextWindow(model);
		if (known) config.contextWindow = known;
	}

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
		// Persist the *current* connection, not the resolveConnection consts —
		// ensureConnectionAlive may have replaced a revoked key mid-startup, and
		// writing the stale consts here would clobber it, forcing a re-prompt on
		// every launch.
		providerUrl: config.baseURL,
		apiKey: config.apiKey,
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
			// Reuse the session's model only when it belongs to the current
			// provider. After a provider switch the stored model likely doesn't
			// exist at the new endpoint, and every resumed request would 400
			// with an opaque provider error — fall back to the configured model
			// instead and say so. Legacy sessions without providerUrl are
			// treated the same way when their model differs from the current one.
			if (!args.cliModel) {
				if (found.providerUrl === config.baseURL) {
					model = found.model;
				} else if (found.model !== model) {
					pickers.log(`Session was using "${found.model}" on a different provider — continuing with "${model}".`);
				}
			}
			if (found.cwd && found.cwd !== cwd && existsSync(found.cwd)) {
				cwd = found.cwd;
			}
		} else if (args.resumeId) {
			console.error(`No saved session found with id "${args.resumeId}".`);
		}
	}

	const session = resumedSession
		? { ...resumedSession, model, providerUrl: config.baseURL }
		: { ...createSession(model, cwd), providerUrl: config.baseURL };
	const runner = createAgentRunner();
	const systemPrompt = buildSystemPrompt(
		persona,
		contextFilesSuffix,
		rulesSuffix,
		rulesLazySuffix,
		skillsPromptSuffix,
		"", // MCP not connected yet — will be populated on first turn
		cwd,
		{
			model,
			reasoningLevel: config.reasoningLevel,
			reasoningMeta,
		},
	);
	onProgress?.("Connecting MCP servers...");
	const mcpResult = await resolveMcpForCwd(projectDeps, cwd, projectTrusted, settings.disabledMcpServers ?? []);
	const confirmBash = makeConfirmBash(pickers, permissionMode);
	const sshHosts = resolveSshHosts(cwd, projectTrusted);

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
		personaOptions: personaOpts,
		personas: allPersonas,
		subagentPrompts: loadSubagentPrompts(),
		subagentModel: settings.subagentModel,
		planModel: settings.planModel,
		reasoningMeta,
		confirmBash,
		projectDeps,
		projectTrusted,
		contextFilesSuffix,
		rulesSuffix,
		rulesLazySuffix,
		directoryRules: resolvedRules.directoryRules,
		activeAutoRules: [],
		skillsPromptSuffix,
		sshHosts,
		resumed: !!resumedSession,
	};
}
