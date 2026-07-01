import OpenAI from "openai";
import { type AppConfig, runOnboardingCheck } from "../core/config.ts";
import { formatContextFilesForPrompt, loadProjectContextFiles } from "../core/context-files.ts";
import { compactSessionMessages } from "../core/loop.ts";
import { closeMcpConnections, type McpSetupResult } from "../core/mcp.ts";
import { findPersona, listPersonas, type Persona } from "../core/personas.ts";
import {
	buildSystemPrompt,
	type ProjectResolverDeps,
	resolveMcpForCwd,
	resolveProjectTrustForCwd,
	resolveSkillsForCwd,
} from "../core/project.ts";
import { getModelsCache } from "../core/readline.ts";
import {
	addGlobalRule,
	addProjectRule,
	deleteGlobalRule,
	deleteProjectRule,
	formatRulesForPrompt,
	loadRules,
	parseGlobalRules,
	parseProjectRules,
} from "../core/rules.ts";
import { addUsage, createSession, estimateTokens, type SessionState, saveSession } from "../core/session.ts";
import { type PermissionMode, updateSettings } from "../core/settings.ts";
import { formatSkillInvocation, type Skill } from "../core/skills.ts";
import { getReasoningOptions, type ModelReasoningMeta } from "../core/vendors.ts";
import {
	selectModel,
	selectPermissionMode,
	selectPersona,
	selectReasoningLevel,
	selectSession,
} from "../pickers/domain.ts";
import type { Pickers } from "../pickers/types.ts";
import type { PendingImage, UseAgentSession } from "./useAgentSession.ts";

/** Slash commands shown in the Composer's autocomplete palette. */
export const SLASH_COMMANDS: Array<{ name: string; description: string }> = [
	{ name: "/clear", description: "Clear context (and save)" },
	{ name: "/compact", description: "Compact context now" },
	{ name: "/new", description: "Start a new session" },
	{ name: "/abort", description: "Abort the current run" },
	{ name: "/steer", description: "Inject a message while running" },
	{ name: "/queue", description: "Queue a message for after the run" },
	{ name: "/queue-reset", description: "Clear the message queue" },
	{ name: "/model", description: "Show or change model" },
	{ name: "/reasoning", description: "Change reasoning level" },
	{ name: "/persona", description: "Show or change persona" },
	{ name: "/personas", description: "List available personas" },
	{ name: "/skills", description: "List loaded skills" },
	{ name: "/mcp", description: "List connected MCP servers" },
	{ name: "/reload", description: "Reload skills + MCP for cwd" },
	{ name: "/provider", description: "Change provider URL and API key" },
	{ name: "/permissions", description: "Change bash confirmation mode" },
	{ name: "/sessions", description: "List / switch / delete sessions" },
	{ name: "/usage", description: "Show cumulative token usage" },
	{ name: "/context", description: "Show current context size" },
	{ name: "/rules", description: "List rules (local + global)" },
	{ name: "/rules add", description: "Add a rule (local or global)" },
	{ name: "/rules delete", description: "Delete a rule (local or global)" },
	{ name: "/quit", description: "Save and exit" },
	{ name: "/help", description: "Show this command list" },
];

export interface CommandDeps {
	agent: UseAgentSession;
	session: SessionState;
	config: AppConfig;
	running: boolean;
	onQuit: () => void;
	showNotice: (text: string) => void;
	cwd: string;
	setCwd: (cwd: string) => void;
	currentPersona: Persona;
	setCurrentPersona: (p: Persona) => void;
	skills: Skill[];
	setSkills: (s: Skill[]) => void;
	skillsPromptSuffix: string;
	setSkillsPromptSuffix: (s: string) => void;
	contextFilesSuffix: string;
	setContextFilesSuffix: (s: string) => void;
	rulesSuffix: string;
	setRulesSuffix: (s: string) => void;
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
	reasoningMeta: ModelReasoningMeta | undefined;
	setReasoningMeta: (m: ModelReasoningMeta | undefined) => void;
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
		skillsPromptSuffix?: string;
	} = {},
): void {
	deps.setSystemPrompt(
		buildSystemPrompt(
			overrides.persona ?? deps.currentPersona,
			overrides.contextFilesSuffix ?? deps.contextFilesSuffix,
			overrides.rulesSuffix ?? deps.rulesSuffix,
			overrides.skillsPromptSuffix ?? deps.skillsPromptSuffix,
			cwd,
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

/** Commands allowed while the agent is running — plain text is rejected. */
const RUNNING_COMMANDS = new Set(["/queue", "/queue-reset", "/steer", "/abort", "/stop"]);

export function canSubmitDuringRun(text: string): boolean {
	const input = text.trim();
	if (!input.startsWith("/")) return false;
	const cmd = input.split(/\s+/)[0]!;
	return RUNNING_COMMANDS.has(cmd);
}

/**
 * Route a line of user input. Every slash command from --basic is handled
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
	if (input === "/steer" || input.startsWith("/steer ")) {
		// No transient showNotice here — agent.pendingSteers now renders above
		// the composer for as long as the message is actually queued (see
		// App.tsx), not on a fixed timer that could clear it long before a
		// tool-heavy turn gets around to draining the queue.
		agent.steer(input.slice(7).trim());
		return;
	}
	if (input.startsWith("/queue ")) {
		const t = input.slice(7).trim();
		agent.followUp(t);
		return;
	}

	if (running) {
		showNotice("[Agent running — use /queue, /steer, or /abort]");
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
			const result = await compactSessionMessages(
				session.messages,
				config,
				session.model,
				undefined,
				(attempt, maxAttempts, reason) => showNotice(`[Retry ${attempt}/${maxAttempts}: ${reason}]`),
				(usage) => addUsage(session, usage),
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
		// See useAgentSession.ts's clearContext for why this is needed: the old
		// transcript is permanently in the terminal's scrollback (Static), so
		// resetting the messages array alone leaves it sitting on screen.
		process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
		agent.refresh();
		showNotice(`[New session: ${session.id}]`);
		return;
	}

	if (input === "/model") {
		showNotice(`[Current model: ${session.model}]`);
		const selection = await selectModel(config, deps.pickers);
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

	if (input === "/reasoning") {
		const meta = deps.reasoningMeta ?? getModelsCache().find((m) => m.id === session.model)?.reasoning;
		const options = getReasoningOptions(meta ?? null);
		if (options.length === 0) {
			showNotice(`[This model doesn't report reasoning support — staying "${config.reasoningLevel}"]`);
			return;
		}
		showNotice(`[Current reasoning: ${config.reasoningLevel}]`);
		await selectReasoningLevel(config, session.model, deps.pickers, meta);
		updateSettings({ reasoningLevel: config.reasoningLevel });
		showNotice(`[Reasoning: ${config.reasoningLevel}]`);
		return;
	}

	if (input === "/personas") {
		const lines = listPersonas().map(
			(p) => `${p.name}${p.name === deps.currentPersona.name ? " (current)" : ""} — ${p.label}`,
		);
		showNotice(`[Personas: ${lines.join(" | ")}]`);
		return;
	}

	if (input === "/persona") {
		showNotice(`[Current persona: ${deps.currentPersona.label} (${deps.currentPersona.name})]`);
		const selected = await selectPersona(deps.pickers);
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
		const found = findPersona(name);
		if (!found) {
			showNotice(`[Unknown persona "${name}". Use /personas to list available ones.]`);
			return;
		}
		deps.setCurrentPersona(found);
		updateSettings({ persona: found.name });
		rebuildSystemPrompt(deps, deps.cwd, { persona: found });
		showNotice(`[Persona: ${found.label}]`);
		return;
	}

	if (input === "/skills") {
		if (deps.skills.length === 0) {
			showNotice("[No skills loaded. See --skill <path> and .cast/skills/]");
		} else {
			const lines = deps.skills.map(
				(s) => `/skill:${s.name}${s.disableModelInvocation ? " (manual-only)" : ""} [${s.source}]`,
			);
			showNotice(`[Skills: ${lines.join(" | ")}]`);
		}
		return;
	}

	if (input === "/mcp") {
		if (deps.mcpResult.connections.length === 0) {
			showNotice("[No MCP servers connected. See --mcp <path>, .cast/mcp.json]");
		} else {
			const lines = deps.mcpResult.connections.map((c) => `${c.serverName} (${c.toolCount} tools)`);
			showNotice(`[MCP: ${lines.join(" | ")}]`);
		}
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
		const rulesSuffix = formatRulesForPrompt(loadRules(deps.cwd, trusted));
		deps.setRulesSuffix(rulesSuffix);
		rebuildSystemPrompt(deps, deps.cwd, { contextFilesSuffix, rulesSuffix, skillsPromptSuffix });
		await closeMcpConnections(deps.mcpResult.connections);
		deps.setMcpResult(await resolveMcpForCwd(deps.projectDeps, deps.cwd, trusted));
		showNotice(`[Reloaded: ${newSkills.length} skill(s), ${deps.mcpResult.connections.length} mcp server(s)]`);
		return;
	}

	if (input.startsWith("/skill:")) {
		const rest = input.slice("/skill:".length);
		const spaceIdx = rest.indexOf(" ");
		const skillName = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
		const skillArgs = spaceIdx === -1 ? undefined : rest.slice(spaceIdx + 1).trim();
		const skill = deps.skills.find((s) => s.name === skillName);
		if (!skill) {
			showNotice(`[No skill named "${skillName}". Use /skills to list available.]`);
			return;
		}
		await agent.submit(formatSkillInvocation(skill, skillArgs));
		return;
	}

	if (input === "/provider") {
		const newUrl = await deps.pickers.promptText(
			`New base URL (current: ${config.baseURL})`,
			undefined,
			config.baseURL,
		);
		const newKey = await deps.pickers.promptText(
			"New API key (current ends with)",
			undefined,
			config.apiKey.slice(-4),
		);
		const finalUrl = (newUrl ?? "").trim() || config.baseURL;
		const finalKey = (newKey ?? "").trim() || config.apiKey;
		if (finalUrl === config.baseURL && finalKey === config.apiKey) {
			showNotice("[No changes.]");
			return;
		}
		showNotice("[Verifying credentials...]");
		try {
			const testClient = new OpenAI({ baseURL: finalUrl, apiKey: finalKey, fetch: globalThis.fetch });
			const list = await testClient.models.list();
			await list[Symbol.asyncIterator]().next();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			showNotice(`[Verification failed: ${message.slice(0, 200)}]`);
			return;
		}
		config.baseURL = finalUrl;
		config.apiKey = finalKey;
		updateSettings({ providerUrl: finalUrl, apiKey: finalKey });
		showNotice(`[Provider changed to: ${finalUrl}. Select a model.]`);
		const selection = await selectModel(config, deps.pickers);
		if (!selection) {
			showNotice("[Cancelled — provider updated, but model unchanged (it may not work against the new provider)]");
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

	if (input === "/permissions") {
		showNotice(`[Current permission mode: ${deps.permissionMode}]`);
		const newMode = await selectPermissionMode(deps.pickers, deps.permissionMode);
		await applyPermissionMode(deps, newMode);
		return;
	}

	if (input === "/permissions default" || input === "/permissions bypass") {
		const newMode = input.endsWith("bypass") ? "bypass" : "default";
		await applyPermissionMode(deps, newMode);
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
		let contextFilesSuffix: string | undefined;
		let rulesSuffix: string | undefined;
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
			rulesSuffix = formatRulesForPrompt(loadRules(chosen.cwd, trusted));
			deps.setRulesSuffix(rulesSuffix);
			await closeMcpConnections(deps.mcpResult.connections);
			deps.setMcpResult(await resolveMcpForCwd(deps.projectDeps, chosen.cwd, trusted));
		}
		rebuildSystemPrompt(deps, chosen.cwd || deps.cwd, { contextFilesSuffix, rulesSuffix, skillsPromptSuffix });
		agent.refresh();
		showNotice(`[Switched to session: ${session.id} (${session.messages.length} messages)]`);
		return;
	}

	if (input === "/usage") {
		const u = session.usage;
		const cost = u.cost ? ` · $${u.cost.toFixed(4)}` : "";
		showNotice(`[Prompt: ${u.promptTokens} · Completion: ${u.completionTokens} · Total: ${u.totalTokens}${cost}]`);
		return;
	}

	if (input === "/context") {
		const used = estimateTokens(session.messages);
		const budget = config.contextWindow - config.maxResponseTokens;
		const pct = budget > 0 ? ((used / budget) * 100).toFixed(1) : "?";
		const triggerPct = Math.round(config.compactionThreshold * 100);
		showNotice(
			`[Context: ~${used.toLocaleString()} / ${budget.toLocaleString()} tokens (${pct}%, compacts at ${triggerPct}%)]`,
		);
		return;
	}

	if (input === "/rules" || input === "/rules list") {
		const localRules = parseProjectRules(deps.cwd);
		const globalRules = parseGlobalRules();
		const parts: string[] = [];
		if (localRules.length > 0) {
			parts.push("Local rules:");
			for (const r of localRules) parts.push(`  ${localRules.indexOf(r) + 1}. ${r}`);
		}
		if (globalRules.length > 0) {
			parts.push("Global rules:");
			for (const r of globalRules) parts.push(`  ${globalRules.indexOf(r) + 1}. ${r}`);
		}
		if (parts.length === 0) {
			showNotice("No rules yet. Use /rules add <text> to add one.");
		} else {
			showNotice(parts.join("\n"));
		}
		return;
	}

	if (input.startsWith("/rules add ")) {
		const text = input.slice("/rules add ".length).trim();
		if (!text) {
			showNotice("[Usage: /rules add <text>]");
			return;
		}
		const scope = await deps.pickers.pickOption(
			[
				{ value: "local" as const, label: "Local (this project)" },
				{ value: "global" as const, label: "Global (all projects)" },
			],
			{ title: "Add rule to which scope?" },
		);
		if (scope === null) return;
		if (scope === "local") {
			addProjectRule(deps.cwd, text);
		} else {
			addGlobalRule(text);
		}
		const rulesSuffix = formatRulesForPrompt(loadRules(deps.cwd, deps.projectTrusted));
		deps.setRulesSuffix(rulesSuffix);
		rebuildSystemPrompt(deps, deps.cwd, { rulesSuffix });
		if (scope === "local" && !deps.projectTrusted) {
			showNotice("[Rule added — not active yet, this project isn't trusted]");
		} else {
			showNotice(`[Rule added to ${scope} rules]`);
		}
		return;
	}

	if (input === "/rules add") {
		showNotice("[Usage: /rules add <text>]");
		return;
	}

	if (input === "/rules delete") {
		const scope = await deps.pickers.pickOption(
			[
				{ value: "local" as const, label: "Local (this project)" },
				{ value: "global" as const, label: "Global (all projects)" },
			],
			{ title: "Delete from which scope?" },
		);
		if (scope === null) return;
		let rules = scope === "local" ? parseProjectRules(deps.cwd) : parseGlobalRules();
		if (rules.length === 0) {
			showNotice(`No ${scope} rules to delete.`);
			return;
		}
		let deleted = 0;
		while (true) {
			rules = scope === "local" ? parseProjectRules(deps.cwd) : parseGlobalRules();
			if (rules.length === 0) break;
			const options = rules.map((r, i) => ({
				value: i + 1,
				label: `${i + 1}. ${r}`,
			}));
			const picked = await deps.pickers.pickOption(options, {
				title: `Delete which ${scope} rule? (${deleted} deleted so far, Esc to finish)`,
			});
			if (picked === null) break;
			if (scope === "local") deleteProjectRule(deps.cwd, picked);
			else deleteGlobalRule(picked);
			deleted++;
		}
		if (deleted > 0) {
			const rulesSuffix = formatRulesForPrompt(loadRules(deps.cwd, deps.projectTrusted));
			deps.setRulesSuffix(rulesSuffix);
			rebuildSystemPrompt(deps, deps.cwd, { rulesSuffix });
			showNotice(`Deleted ${deleted} ${scope} rule(s).`);
		} else {
			showNotice("No rules deleted.");
		}
		return;
	}

	if (input === "/help") {
		showNotice(
			"[/clear /compact /new /abort /queue /queue-reset /steer /model /reasoning /persona /personas /skills /mcp /reload /skill: /provider /permissions /sessions /usage /context /rules /rules list /rules add /rules delete /quit]",
		);
		return;
	}

	if (input === "/queue-reset") {
		agent.resetQueue();
		showNotice("[Queue cleared]");
		return;
	}

	// Unknown slash command — submit to agent as regular text (could be a
	// file path starting with /, e.g. /tmp/cast-clipboard-UUID.png).
	await agent.submit(text);
}
