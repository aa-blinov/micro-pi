import { type AppConfig, fetchModels, runOnboardingCheck } from "../core/config.ts";
import { DEFAULT_PERSONA, type LoadPersonasOptions, listPersonas, type Persona } from "../core/personas.ts";
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

/**
 * Re-prompt for provider URL + key when an established connection has gone bad
 * (revoked key, moved endpoint). Unlike resolveConnection, this always asks —
 * it's reached only after a liveness probe already failed, so the saved values
 * are known-broken. The URL is pre-filled (usually only the key changed) and
 * kept if left blank; a fresh key is required (the old one is known-bad, so
 * "keep current" makes no sense). Returns null if the user cancels (Escape).
 */
export async function reconfigureConnection(
	pickers: Pickers,
	current: { baseURL: string; apiKey: string },
	reason: string,
): Promise<{ baseURL: string; apiKey: string } | null> {
	pickers.log(reason);

	const url = await pickers.promptText("Provider base URL", current.baseURL, current.baseURL);
	if (url === null) return null;
	const baseURL = url.trim() || current.baseURL;

	const key = await pickers.promptText(
		"Provider API key",
		undefined,
		`new key (current ends ...${current.apiKey.slice(-4)})`,
	);
	if (key === null) return null;
	const apiKey = key.trim();
	if (!apiKey) return null;

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
export async function selectPersona(pickers: Pickers, options?: LoadPersonasOptions): Promise<Persona | null> {
	const personas = listPersonas(options);
	const defaultIdx = Math.max(
		0,
		personas.findIndex((p) => p.name === DEFAULT_PERSONA),
	);
	const picked = await pickers.pickOption(
		personas.map((p) => ({
			value: p,
			label: `${p.label} (${p.source})`,
			description: p.description,
		})),
		{ title: "Personas", defaultIndex: defaultIdx },
	);
	return picked;
}

// ============================================================================
// Session resume
// ============================================================================

function getFirstUserMessage(session: SessionState): string {
	const msg = session.messages.find((m) => m.role === "user");
	if (!msg) return "";
	const content =
		typeof msg.content === "string"
			? msg.content
			: Array.isArray(msg.content)
				? ((msg.content.find((p: { type?: string }) => p.type === "text") as { text?: string })?.text ?? "")
				: "";
	return content.replace(/\n/g, " ").trim();
}

function shortenCwd(cwd: string): string {
	const parts = cwd.split("/").filter(Boolean);
	if (parts.length <= 1) return cwd;
	const last = parts[parts.length - 1]!;
	return last.length > 12 ? `.../${last.slice(0, 12)}...` : `.../${last}`;
}

function pad(str: string, width: number): string {
	return str.length >= width ? `${str.slice(0, width - 1)}\u200b ` : str.padEnd(width);
}

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
		}>[] = sessions.map((s) => {
			const firstMsg = getFirstUserMessage(s);
			const cwd = shortenCwd(s.cwd || "");
			const date = s.updatedAt.slice(0, 10);
			const time = s.updatedAt.slice(11, 16);
			const msgCol = firstMsg.length > 40 ? `${firstMsg.slice(0, 40)}...` : firstMsg || "(empty)";
			return {
				value: { session: s, action: "resume" as const },
				label: `${pad(cwd, 18)}${pad(msgCol, 43)}${date} ${time}  ${s.messages.length} msgs`,
				description: firstMsg ? firstMsg : undefined,
			};
		});
		options.push({ value: { session: null, action: "fresh" as const }, label: "Start fresh" });
		options.push({ value: { session: null, action: "delete" as const }, label: "Delete a session" });

		const picked = await pickers.pickOption(options, { title: "Sessions (most recent first)" });
		if (!picked) return null;
		if (picked.action === "fresh") return null;
		if (picked.action === "resume" && picked.session) return picked.session;

		const delOptions = sessions.map((s) => {
			const firstMsg = getFirstUserMessage(s);
			const cwd = shortenCwd(s.cwd || "");
			const msgCol = firstMsg.length > 40 ? `${firstMsg.slice(0, 40)}...` : firstMsg || "(empty)";
			return { value: s, label: `${pad(cwd, 18)}${pad(msgCol, 43)}${s.id}` };
		});
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
 * Validate a model behind a spinner, capturing the specific failure line for
 * display. runOnboardingCheck's per-step progress ("endpoint: ok", "model:
 * ok", ...) is pure noise here — it flashes and vanishes as the picker
 * re-renders — so we run it `silent` (suppresses the success chatter) and
 * route its output into a capture-only sink rather than the notice line. Only
 * the *failure* reason is kept, to be shown in red on the next picker; success
 * shows nothing but the spinner that was already up.
 */
async function validateModelForSelection(
	config: AppConfig,
	pickers: Pickers,
	model: string,
): Promise<{ ok: boolean; reason?: string }> {
	const done = pickers.status?.(`Checking ${model}...`);
	let lastLine = "";
	try {
		const ok = await runOnboardingCheck(config, model, {
			silent: true,
			log: (t) => {
				lastLine = t;
			},
		});
		return { ok, reason: ok ? undefined : lastLine || `Model "${model}" is unavailable` };
	} finally {
		done?.();
	}
}

/**
 * Returns null if the user cancels (Escape / empty submit) rather than
 * exiting the process — this is also called mid-session (the TUI's
 * /model and /provider commands), where exiting on cancel would kill the
 * whole running app instead of just leaving the current model in place.
 * Onboarding call sites, which do need to exit if nothing gets picked,
 * check for null themselves and exit there instead.
 *
 * `lastError` carries the reason a previous attempt failed so it can be shown
 * in the picker title — the retry recursion would otherwise bounce the user
 * straight back to the list with no visible sign of what went wrong.
 */
export async function selectModel(
	config: AppConfig,
	pickers: Pickers,
	current?: string,
	lastError?: string,
): Promise<ModelSelection | null> {
	const fetching = pickers.status?.("Loading models...");
	const result = await fetchModels(config);
	fetching?.();

	// A real model pick carries its metadata; the sentinel row routes to
	// free-text entry instead.
	type ModelChoice = { model: string; reasoningMeta?: ModelReasoningMeta; contextWindow?: number } | { custom: true };
	const options: PickOption<ModelChoice>[] = [];

	if (result.ok && result.models && result.models.length > 0) {
		setModelsCache(result.models);
		for (const m of result.models) {
			options.push({
				value: { model: m.id, reasoningMeta: m.reasoning, contextWindow: m.contextWindow },
				label: `${m.id}${m.reasoning ? " [reasoning]" : ""}${m.id === current ? " (current)" : ""}`,
			});
		}
	}

	// The provider's /v1/models list is never authoritative — aliases,
	// freshly-released ids, and private deployments can all be absent — so a
	// user must always be able to type an id by hand. When the list came back
	// empty there's nothing to choose from, so skip the one-row menu and go
	// straight to input.
	if (options.length === 0) {
		return promptCustomModel(
			config,
			pickers,
			current,
			lastError ?? (result.error ? `Couldn't load model list: ${result.error}` : undefined),
		);
	}

	options.push({ value: { custom: true }, label: "Enter a custom model id..." });

	// Start the cursor on the current model so /model doubles as "show
	// current" — the picker opens highlighting what's already selected.
	const currentIdx = current ? options.findIndex((o) => "model" in o.value && o.value.model === current) : -1;
	const picked = await pickers.pickOption(options, {
		title: "Select model",
		// Prior failure shown in red above the title; stays on screen the whole
		// time the picker is open, unlike a transient notice line.
		error: lastError,
		defaultIndex: currentIdx >= 0 ? currentIdx : 0,
	});
	if (!picked) return null;

	if ("custom" in picked) {
		return promptCustomModel(config, pickers, current);
	}

	const { ok, reason } = await validateModelForSelection(config, pickers, picked.model);
	if (ok) {
		return { model: picked.model, reasoningMeta: picked.reasoningMeta, contextWindow: picked.contextWindow };
	}
	return selectModel(config, pickers, current, reason);
}

/**
 * Prompt for a raw model id and validate it with a real provider round-trip
 * (runOnboardingCheck) before returning. The selection is only handed back —
 * and therefore only applied by the caller — once the provider confirms it
 * actually serves that id; an unvalidated id is never applied. On failure this
 * re-opens the full picker (carrying the reason so it stays visible) so the
 * user can retry, pick from the list, or cancel. Escape / empty submit returns
 * null (cancel), leaving a mid-session /model with the current model untouched.
 */
async function promptCustomModel(
	config: AppConfig,
	pickers: Pickers,
	current?: string,
	lastError?: string,
): Promise<ModelSelection | null> {
	// Prior failure shown in red above the prompt (a header that stays on
	// screen), so the user sees why the last id was rejected while typing the
	// next one.
	const name = await pickers.promptText(
		"Custom model id",
		undefined,
		"gpt-4o, claude-sonnet-4-20250514, ...",
		lastError,
	);
	if (name === null) return null;
	const model = name.trim();
	if (!model) return null;

	const { ok, reason } = await validateModelForSelection(config, pickers, model);
	if (ok) return { model };

	return selectModel(config, pickers, current, reason);
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
		config.reasoningLevel = "unknown";
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

// ============================================================================
// MCP server toggle
// ============================================================================

/**
 * Interactive multi-select for toggling MCP servers on/off. Returns the list
 * of server names the user wants ENABLED, or null on cancel.
 */
export async function selectMcpServers(
	pickers: Pickers,
	allServerNames: string[],
	disabledNames: string[],
	toolCounts: Record<string, number>,
	/** Focused-row blurb (usually tool names). */
	descriptions: Record<string, string> = {},
): Promise<string[] | null> {
	const disabledSet = new Set(disabledNames);
	const names = [...allServerNames].sort((a, b) => a.localeCompare(b));
	const options: PickOption<string>[] = names.map((name) => {
		const count = toolCounts[name];
		const status = disabledSet.has(name) ? "disabled" : count !== undefined ? `${count} tools` : "disconnected";
		const blurb = descriptions[name];
		return {
			value: name,
			label: `${name} (${status})`,
			description: blurb || (status === "disconnected" ? "Not connected" : undefined),
		};
	});
	const initialSelected = names.filter((n) => !disabledSet.has(n));
	const picked = await pickers.pickMulti(options, {
		title: "MCP Servers (space to toggle, enter to confirm)",
		initialSelected,
	});
	return picked;
}

export interface SkillPickItem {
	name: string;
	description?: string;
	source: string;
	disableModelInvocation: boolean;
	pluginId?: string;
	/** False when the skill's marketplace pack is disabled via `/plugin`. */
	pluginEnabled?: boolean;
}

/** Label bits for `/skills` picker and list (includes plugin provenance). */
export function formatSkillPickLabel(
	skill: SkillPickItem,
	disabled: boolean,
): {
	label: string;
	description?: string;
	muted: boolean;
	locked: boolean;
} {
	const packOff = skill.source === "plugin" && skill.pluginEnabled === false;
	const bits: string[] = [];
	if (skill.source === "plugin" && skill.pluginId) {
		bits.push(`plugin · ${skill.pluginId}`);
	} else {
		bits.push(skill.source);
	}
	if (skill.disableModelInvocation) bits.push("manual-only");
	if (packOff) bits.push("pack off");
	else if (disabled) bits.push("disabled");
	const body = skill.description?.trim();
	const description = packOff
		? body
			? `Enable this pack with /plugin first. ${body}`
			: "Enable this pack with /plugin first"
		: body || undefined;
	return {
		label: `${skill.name} (${bits.join(", ")})`,
		description,
		muted: packOff,
		locked: packOff,
	};
}

/**
 * Toggle discovered skills on/off. Returns names the user wants ENABLED, or null
 * on cancel. Same interaction as /mcp. Skills from a disabled plugin pack are
 * shown locked (Space ignored) until the pack is re-enabled via `/plugin`.
 */
export async function selectSkills(
	pickers: Pickers,
	skills: SkillPickItem[],
	disabledNames: string[],
): Promise<string[] | null> {
	const disabledSet = new Set(disabledNames);
	const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
	const options: PickOption<string>[] = sorted.map((s) => {
		const meta = formatSkillPickLabel(s, disabledSet.has(s.name));
		return {
			value: s.name,
			label: meta.label,
			description: meta.description,
			muted: meta.muted,
			locked: meta.locked,
		};
	});
	const initialSelected = sorted
		.filter((s) => !(s.source === "plugin" && s.pluginEnabled === false) && !disabledSet.has(s.name))
		.map((s) => s.name);
	return pickers.pickMulti(options, {
		title: "Skills (space to toggle, enter to confirm)",
		initialSelected,
	});
}

/**
 * Toggle installed marketplace plugins on/off. Returns plugin ids
 * (`name@marketplace`) the user wants ENABLED, or null on cancel.
 */
export async function selectPlugins(
	pickers: Pickers,
	plugins: Array<{ id: string; enabled: boolean; description?: string }>,
): Promise<string[] | null> {
	const sorted = [...plugins].sort((a, b) => a.id.localeCompare(b.id));
	const options: PickOption<string>[] = sorted.map((p) => ({
		value: p.id,
		label: `${p.id}${p.enabled ? "" : " (disabled)"}`,
		description: p.description?.trim() || undefined,
	}));
	const initialSelected = sorted.filter((p) => p.enabled).map((p) => p.id);
	return pickers.pickMulti(options, {
		title: "Plugins (space to toggle, enter to confirm)",
		initialSelected,
	});
}
