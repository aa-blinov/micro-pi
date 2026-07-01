import { type AppConfig, fetchModels, runOnboardingCheck } from "../core/config.ts";
import { DEFAULT_PERSONA, listPersonas, type Persona } from "../core/personas.ts";
import { setModelsCache } from "../core/readline.ts";
import { deleteSession, listSessions, type SessionState } from "../core/session.ts";
import { getProjectTrust, type PermissionMode, type Settings, setProjectTrust } from "../core/settings.ts";
import { buildReasoningParams, getReasoningOptions, type ModelReasoningMeta } from "../core/vendors.ts";
import { type ModelSelection, PERMISSION_MODES, type Pickers, type PickOption } from "./types.ts";

// ============================================================================
// Provider connection
// ============================================================================

export async function resolveConnection(
	pickers: Pickers,
	settings: Settings,
): Promise<{ baseURL: string; apiKey: string }> {
	let baseURL = settings.providerUrl;
	let apiKey = settings.apiKey;

	if (!baseURL || !apiKey) {
		pickers.log(
			"No provider configured yet — any OpenAI-compatible endpoint works\n(OpenRouter, OpenAI, Ollama, vLLM, LiteLLM, etc). Saved for next time.",
		);
	}

	while (!baseURL) {
		const v = await pickers.promptText("Provider base URL", undefined, "https://api.openai.com/v1");
		if (v === null) process.exit(0);
		baseURL = v.trim() || undefined;
	}
	while (!apiKey) {
		const v = await pickers.promptText("Provider API key", undefined, "sk-...");
		if (v === null) process.exit(0);
		apiKey = v.trim() || undefined;
	}

	return { baseURL, apiKey };
}

// ============================================================================
// Project trust
// ============================================================================

export async function resolveProjectTrust(
	pickers: Pickers,
	settings: Settings,
	cwd: string,
	resourceLines: string[],
): Promise<boolean> {
	const existing = getProjectTrust(settings, cwd);
	if (existing !== undefined) return existing;
	if (!process.stdin.isTTY) return false;

	pickers.log(
		[
			`This project has local resources at ${cwd}:`,
			...resourceLines,
			"These are project-local and could come from a cloned repository.",
		].join("\n"),
	);

	const picked = await pickers.pickOption(
		[
			{ value: true, label: "Trust and load its resources" },
			{ value: false, label: "Don't load project resources" },
		],
		{ title: "Trust this project?" },
	);
	const trusted = picked === true;
	setProjectTrust(cwd, trusted);
	pickers.log(
		trusted
			? "Trusted — remembered for next time."
			: "Not trusted — project resources won't load. Change this in ~/.cast/settings.json if needed.",
	);
	return trusted;
}

// ============================================================================
// Persona
// ============================================================================

/**
 * Returns null if the user cancels (Escape) rather than exiting the process —
 * this is also called mid-session (e.g. the TUI's /persona command), where
 * exiting on cancel would kill the whole running app instead of just leaving
 * the current persona in place. Onboarding call sites, which do need to exit
 * if nothing gets picked, check for null themselves and exit there instead.
 */
export async function selectPersona(pickers: Pickers): Promise<Persona | null> {
	const personas = listPersonas();
	const defaultIdx = Math.max(
		0,
		personas.findIndex((p) => p.name === DEFAULT_PERSONA),
	);
	const picked = await pickers.pickOption(
		personas.map((p) => ({ value: p, label: p.label, description: p.description })),
		{ title: "Personas", defaultIndex: defaultIdx },
	);
	return picked;
}

// ============================================================================
// Session resume
// ============================================================================

export async function selectSession(pickers: Pickers): Promise<SessionState | null> {
	while (true) {
		const sessions = listSessions()
			.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
			.slice(0, 20);

		if (sessions.length === 0) {
			pickers.log("No saved sessions to resume — starting fresh.");
			return null;
		}

		const options: PickOption<{
			session: SessionState | null;
			action: "resume" | "fresh" | "delete";
		}>[] = sessions.map((s, i) => ({
			value: { session: s, action: "resume" as const },
			label: `${i + 1}. ${s.id} (${s.messages.length} msgs) — ${s.updatedAt.slice(0, 16)}`,
		}));
		options.push({ value: { session: null, action: "fresh" as const }, label: "Start fresh" });
		options.push({ value: { session: null, action: "delete" as const }, label: "Delete a session" });

		const picked = await pickers.pickOption(options, { title: "Saved sessions (most recent first)" });
		if (!picked) return null;
		if (picked.action === "fresh") return null;
		if (picked.action === "resume" && picked.session) return picked.session;

		const delOptions = sessions.map((s, i) => ({ value: s, label: `${i + 1}. ${s.id}` }));
		const toDelete = await pickers.pickOption(delOptions, { title: "Delete which session?" });
		if (toDelete) {
			deleteSession(toDelete.id);
			pickers.log(`Deleted session ${toDelete.id}.`);
		}
	}
}

// ============================================================================
// Model + reasoning
// ============================================================================

/**
 * Returns null if the user cancels (Escape / empty submit) rather than
 * exiting the process — this is also called mid-session (the TUI's
 * /model and /provider commands), where exiting on cancel would kill the
 * whole running app instead of just leaving the current model in place.
 * Onboarding call sites, which do need to exit if nothing gets picked,
 * check for null themselves and exit there instead.
 */
export async function selectModel(config: AppConfig, pickers: Pickers): Promise<ModelSelection | null> {
	pickers.log(`Endpoint: ${config.baseURL}\nFetching models...`);
	const result = await fetchModels(config);

	const options: PickOption<{
		model: string;
		reasoningMeta?: ModelReasoningMeta;
		contextWindow?: number;
	}>[] = [];

	if (result.ok && result.models && result.models.length > 0) {
		setModelsCache(result.models);
		pickers.log(`Found ${result.models.length} models.`);
		for (const m of result.models) {
			options.push({
				value: { model: m.id, reasoningMeta: m.reasoning, contextWindow: m.contextWindow },
				label: `${m.id}${m.reasoning ? " [reasoning]" : ""}`,
			});
		}
	} else {
		pickers.log(result.error ? `Models not available: ${result.error}` : "Models not available.");
	}

	if (options.length > 0) {
		const picked = await pickers.pickOption(options, { title: "Select model" });
		if (!picked) return null;
		const ok = await runOnboardingCheck(config, picked.model, { log: pickers.log });
		if (ok)
			return {
				model: picked.model,
				reasoningMeta: picked.reasoningMeta,
				contextWindow: picked.contextWindow,
			};
		pickers.log("Onboarding check failed — try again.");
		return selectModel(config, pickers);
	}

	const name = await pickers.promptText("Model name", undefined, "gpt-4o, claude-sonnet-4-20250514, ...");
	if (!name) return null;
	const ok = await runOnboardingCheck(config, name.trim(), { log: pickers.log });
	if (ok) return { model: name.trim() };
	pickers.log("Onboarding check failed — try again.");
	return selectModel(config, pickers);
}

export async function tryCliModel(config: AppConfig, model: string): Promise<ModelSelection | null> {
	console.log();
	const ok = await runOnboardingCheck(config, model);
	if (ok) return { model };
	console.log("\nFalling back to interactive selection.\n");
	return null;
}

export async function selectReasoningLevel(
	config: AppConfig,
	_model: string,
	pickers: Pickers,
	reasoningMeta?: ModelReasoningMeta,
): Promise<void> {
	const options = getReasoningOptions(reasoningMeta ?? null);
	if (options.length === 0) {
		config.reasoningLevel = "off";
		config.reasoningParams = { body: {}, enabled: false };
		return;
	}

	const picked = await pickers.pickOption(
		options.map((o) => ({ value: o.value, label: o.label })),
		{ title: "Reasoning levels", defaultIndex: 0 },
	);
	// Cancelling (Escape) leaves config untouched rather than exiting — this
	// runs mid-session too (TUI's /model, /reasoning, /provider), where
	// exiting on cancel would kill the whole running app. Safe to just no-op:
	// config already holds whatever reasoning level was in effect before.
	if (!picked) return;
	config.reasoningLevel = picked;
	config.reasoningParams = buildReasoningParams(picked);
}

// ============================================================================
// Permission mode
// ============================================================================

export async function selectPermissionMode(pickers: Pickers, current: PermissionMode): Promise<PermissionMode> {
	const defaultIdx = Math.max(
		0,
		PERMISSION_MODES.findIndex((m) => m.value === current),
	);
	const picked = await pickers.pickOption(
		PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label })),
		{ title: "Permission modes", defaultIndex: defaultIdx },
	);
	return picked ?? current;
}
