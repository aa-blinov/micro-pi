import { Box, Text, useApp } from "ink";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppConfig } from "../core/config.ts";
import { formatContextFilesForPrompt, resolveNestedContextFiles } from "../core/context-files.ts";
import { createPlanState, readActivePlan } from "../core/plan.ts";
import { buildSystemPrompt, makeConfirmBash } from "../core/project.ts";
import {
	formatRulesForTurn,
	matchAutoRules,
	type Rule,
	selectMentionedRules,
	unionStickyRules,
} from "../core/rules.ts";
import type { SessionUsage } from "../core/session.ts";
import { estimateTokens, saveSession } from "../core/session.ts";
import { loadSettings } from "../core/settings.ts";
import type { StartupResult } from "../core/startup.ts";
import { setSuspendHook } from "../core/stdin-manager.ts";
import { fetchLatestVersion, isNewerVersion, isReleaseInstall } from "../core/upgrade.ts";
import { ModalPicker, TextInputModal } from "../pickers/ink.tsx";
import { ChatLog } from "./ChatLog.tsx";
import { Composer } from "./Composer.tsx";
import { canSubmitDuringRun, handleInput } from "./commands.ts";
import { useModalBridge } from "./pickerBridge.ts";
import { Spinner } from "./Spinner.tsx";
import { theme } from "./themes/index.ts";
import { type UseAgentSession, useAgentSession } from "./useAgentSession.ts";
import { useTerminalResync } from "./useTerminalResync.ts";

interface AppProps {
	result: StartupResult;
	version: string;
	initialPrompt?: string;
	onPasteImage?: () => Promise<string | null>;
	onQuit: () => void;
	onRepaintBanner?: () => Promise<void>;
}

export function App(props: AppProps): JSX.Element {
	const { result, version, initialPrompt, onQuit, onPasteImage, onRepaintBanner } = props;
	const { config, runner } = result;

	// Wire Ink's suspendTerminal so execBash can hand the terminal to child
	// processes (live output, password prompts). Done here via the public
	// useApp() hook — the previous wiring in tui.tsx resolved ink's internal
	// instances.js at runtime, which worked in dev but always failed in the
	// release bundle (ink is inlined by esbuild, there's no node_modules/ink
	// to resolve against), silently leaving live bash output to interleave
	// with Ink's frames and stack duplicated composer/status lines.
	const { suspendTerminal } = useApp();
	useEffect(() => {
		setSuspendHook(async (cb) => {
			await suspendTerminal(cb);
		});
	}, [suspendTerminal]);

	const [notice, setNotice] = useState<string | null>(null);
	const noticeDurationRef = useRef(6000);
	const showNotice = useCallback((text: string, duration?: number) => {
		setNotice(text);
		noticeDurationRef.current = duration ?? 6000;
	}, []);

	// Resize/reflow and terminal-scroll desyncs both need the same hard reset
	// (clear + full <Static> replay) — see useTerminalResync for why. Bumping
	// repaintKey is what triggers that replay (see the ChatLog key below).
	const [repaintKey, setRepaintKey] = useState(0);
	useTerminalResync(useCallback(() => setRepaintKey((k) => k + 1), []));

	// Pickers used after mount (slash commands, confirmBash) render their
	// modal inline in this same Ink tree instead of spinning up a second
	// `render()` — see pickerBridge.ts for why that matters. projectDeps.pickers
	// (the standalone onboarding pickers used by runStartup, pre-mount) is
	// intentionally overridden here for every post-mount consumer. One-off
	// status text (connection checks, trust prompts) routes through the same
	// notice line instead of a raw console.log that would corrupt the frame.
	const { pickers, request: modalRequest } = useModalBridge(showNotice);
	const projectDeps = useMemo(() => ({ ...result.projectDeps, pickers }), [result.projectDeps, pickers]);

	const [session] = useState(result.session);
	const [mcpResult, setMcpResult] = useState(result.mcpResult);
	const [currentPersona, setCurrentPersona] = useState(result.persona);
	const [systemPrompt, setSystemPrompt] = useState(result.systemPrompt);
	const [skills, setSkills] = useState(result.skills);
	const [skillsPromptSuffix, setSkillsPromptSuffix] = useState(result.skillsPromptSuffix);
	const [contextFilesSuffix, setContextFilesSuffix] = useState(result.contextFilesSuffix);
	const [rulesSuffix, setRulesSuffix] = useState(result.rulesSuffix);
	const [rulesLazySuffix, setRulesLazySuffix] = useState(result.rulesLazySuffix);
	const [directoryRules, setDirectoryRules] = useState(result.directoryRules);
	const [activeAutoRules, setActiveAutoRules] = useState<Rule[]>([]);
	const [permissionMode, setPermissionMode] = useState(result.permissionMode);
	const [projectTrusted, setProjectTrusted] = useState(result.projectTrusted);
	const [cwd, setCwd] = useState(result.cwd);
	const [reasoningMeta, setReasoningMeta] = useState(result.reasoningMeta);
	const [personaOptions, setPersonaOptions] = useState(result.personaOptions);
	const [personas] = useState(result.personas);
	const [subagentPrompts] = useState(result.subagentPrompts);
	const [subagentModel, setSubagentModel] = useState(result.subagentModel);
	const [webToolsEnabled, setWebToolsEnabled] = useState(() => loadSettings().webTools === true);
	// Mode is per-session state: restored from the (possibly resumed) session
	// on startup, persisted into the session file on every toggle — so quitting
	// mid-planning resumes planning in THAT session, without leaking plan mode
	// into other projects the way the old global settings.mode did. Unset means
	// "build", the default. setPlanMode is the only setter handed out
	// (commands, /new, /sessions), so persistence can't be bypassed.
	const [planMode, setPlanModeState] = useState(() => session.mode === "plan");
	const setPlanMode = useCallback(
		(v: boolean) => {
			setPlanModeState(v);
			session.mode = v ? "plan" : "build";
			saveSession(session);
		},
		[session],
	);
	const disabledTools = useMemo(() => {
		const s = new Set<string>();
		// Web tools respect the user's toggle in BOTH modes
		if (!webToolsEnabled) {
			s.add("web_search");
			s.add("web_fetch");
		}
		if (planMode) {
			// Hard block write-capable tools in plan mode. bash stays advertised:
			// the loop's executor gate restricts it to a read-only allowlist
			// (git log/diff/blame, grep, ls, …) so exploration keeps its teeth.
			s.add("write");
			s.add("edit");
			// Checking off steps and proposing to plan are build-mode acts
			s.add("plan_check");
			s.add("plan_enter");
		} else {
			// Plan authoring tools only available in plan mode; the approved plan
			// can't be rewritten (or discarded) during implementation, only
			// checked off. plan_read stays available in build mode as a read-only
			// reference (it only switches the active plan while plan mode is on).
			s.add("plan_write");
			s.add("plan_edit");
			s.add("plan_done");
			s.add("plan_discard");
		}
		return s;
	}, [webToolsEnabled, planMode]);
	// One object per session, mutated in place: an in-flight run captured this
	// reference at submit time, so /plan and /build toggles must land on the
	// same object for the loop's per-request system prompt sync to see them.
	const planState = useMemo(() => createPlanState(session.id), [session.id]);
	planState.enabled = planMode;
	// Mode-transition signal from the run (plan_done / plan_enter succeeded).
	// A ref, not state: it must not trigger renders mid-run — the dialog opens
	// only when the run settles (see the effect below), so the mode always
	// flips between runs and tool sets stay consistent.
	const planSignalRef = useRef<"done" | "enter" | null>(null);
	const onPlanSignal = useCallback((kind: "done" | "enter") => {
		planSignalRef.current = kind;
	}, []);
	// Message to auto-submit once the mode flip has re-rendered. Submitting in
	// the same tick as setPlanMode would capture the OLD disabledTools/planState
	// closures (the /plan-desc race all over again) — the effect below fires
	// after the render that applied the new mode, so the run gets fresh config.
	const [pendingAutoSubmit, setPendingAutoSubmit] = useState<{ text: string; wantPlanMode: boolean } | null>(null);
	// Theme change counter — forces a re-render when /theme switches the active
	// theme, since theme() reads from a module-level singleton that Ink can't
	// detect on its own.
	const [_themeVer, setThemeVer] = useState(0);
	const onThemeChange = useCallback(() => {
		// Order matters: onRepaintBanner clears the screen (+ scrollback) and
		// reprints the banner; only then bump the version so the <Static> key
		// change replays the recolored history below the fresh banner. Bumping
		// first would append a second copy of the transcript under the old one.
		void (async () => {
			await onRepaintBanner?.();
			setThemeVer((v) => v + 1);
		})();
	}, [onRepaintBanner]);

	const confirmBash = useMemo(() => makeConfirmBash(pickers, permissionMode), [pickers, permissionMode]);

	// Per-turn system prompt rebuild for sticky rules + @-mention.
	// Called by the loop at the start of each outer iteration.
	const rebuildSystemPrompt = useCallback(
		({ userText, contextFiles: ctxFiles }: { userText: string; contextFiles: string[] }) => {
			// 1. Latch auto-attach rules whose globs match files now in context.
			const newAuto = matchAutoRules(directoryRules, ctxFiles);
			const sticky = unionStickyRules(activeAutoRules, newAuto);
			if (sticky.length !== activeAutoRules.length) {
				setActiveAutoRules(sticky);
			}

			// 2. Select @-mentioned rules from the current user message.
			const mentioned = selectMentionedRules(directoryRules, userText);

			// 3. One block: always-apply + sticky auto + mentioned (deduped).
			//    Must include always-apply rules unconditionally — see
			//    formatRulesForTurn.
			const rulesBlock = formatRulesForTurn(directoryRules, sticky, mentioned);

			// 4. Nested AGENTS.md/CLAUDE.md for files touched this session — a
			//    subdirectory instruction file attaches once a file from its
			//    subtree enters context (opencode's per-file resolve model).
			//    Trust-gated like the cwd context file.
			const nestedContext = projectTrusted
				? formatContextFilesForPrompt(resolveNestedContextFiles(cwd, ctxFiles))
				: "";

			// 5. Build the full system prompt.
			return buildSystemPrompt(
				currentPersona,
				contextFilesSuffix + nestedContext,
				rulesBlock,
				rulesLazySuffix,
				skillsPromptSuffix,
				cwd,
				{ model: session.model, reasoningLevel: config.reasoningLevel, mode: planMode ? "plan" : "build" },
			);
		},
		[
			directoryRules,
			activeAutoRules,
			currentPersona,
			contextFilesSuffix,
			rulesLazySuffix,
			skillsPromptSuffix,
			cwd,
			projectTrusted,
			session.model,
			config.reasoningLevel,
			planMode,
		],
	);

	const agent = useAgentSession({
		session,
		config,
		cwd,
		systemPrompt,
		runner,
		permissionMode,
		mcpResult,
		confirmBash,
		rebuildSystemPrompt,
		personas,
		currentPersona: currentPersona.name,
		subagentPrompts,
		subagentModel,
		disabledTools,
		planState,
		onPlanSignal,
	});
	const running = agent.status === "running";
	const canSubmit = useCallback(
		(text: string) => {
			if (agent.status !== "running") return true;
			if (canSubmitDuringRun(text)) return true;
			showNotice("[Agent running — use /queue, /steer, or /abort]");
			return false;
		},
		[agent.status, showNotice],
	);
	const submitRef = useRef(agent.submit);
	submitRef.current = agent.submit;

	// Deferred auto-submit for mode-transition dialogs: fires only after the
	// render that applied the requested mode, so the run picks up the fresh
	// disabledTools/planState instead of the pre-flip closures.
	useEffect(() => {
		if (!pendingAutoSubmit || planMode !== pendingAutoSubmit.wantPlanMode) return;
		const { text } = pendingAutoSubmit;
		setPendingAutoSubmit(null);
		void submitRef.current(text);
	}, [pendingAutoSubmit, planMode]);

	// Mode-transition dialogs, opened when the run settles. plan_done → the
	// approval dialog (the /build gesture, with optional auto-start); plan_enter
	// → "switch to planning?". Signals that arrive after the user already
	// toggled the mode manually are dropped.
	useEffect(() => {
		if (agent.status === "running" || modalRequest || !planSignalRef.current) return;
		const kind = planSignalRef.current;
		planSignalRef.current = null;
		if (kind === "done" && planMode) {
			void (async () => {
				// Full path in the title: terminals make it clickable, so the user
				// can open the plan in their editor straight from the dialog.
				const planPath = readActivePlan(planState).path;
				const choice = await pickers.pickOption(
					[
						{ value: "implement", label: "Approve — switch to build and implement now" },
						{
							value: "fresh",
							label: "Approve — clear context, then implement",
							description: "Drops the planning conversation; the plan survives in the system prompt",
						},
						{ value: "build", label: "Approve — switch to build, I'll start myself" },
						{ value: "refine", label: "Keep planning — I'll give feedback" },
					],
					{ title: planPath ? `Plan ready: ${planPath}` : "Plan ready. What next?" },
				);
				if (choice === "implement" || choice === "fresh") {
					// Fresh start is safe BECAUSE of the mirror block: the plan is
					// re-read from disk into the system prompt, so the exploration
					// chatter can be dropped without losing the decisions.
					if (choice === "fresh") agent.clearContext();
					setPlanMode(false);
					setPendingAutoSubmit({ text: "The plan is approved. Implement it step by step.", wantPlanMode: false });
				} else if (choice === "build") {
					setPlanMode(false);
					showNotice("[Plan approved — your next message starts implementation]");
				} else {
					showNotice("[Staying in plan mode — describe what to change]");
				}
			})();
		} else if (kind === "enter" && !planMode) {
			void (async () => {
				const choice = await pickers.pickOption(
					[
						{ value: true, label: "Yes — enter plan mode" },
						{ value: false, label: "No — continue in build mode" },
					],
					{ title: "Agent suggests planning this task first. Enter plan mode?" },
				);
				if (choice === true) {
					setPlanMode(true);
					setPendingAutoSubmit({
						text: "Plan mode is on. Explore the material and write the plan.",
						wantPlanMode: true,
					});
				} else {
					// The model ended its turn waiting for this decision — resume it,
					// otherwise declining leaves the session hanging in silence.
					showNotice("[Staying in build mode]");
					setPendingAutoSubmit({
						text: "Plan mode declined — proceed with the task directly in build mode.",
						wantPlanMode: false,
					});
				}
			})();
		}
	}, [agent.status, agent.clearContext, modalRequest, planMode, pickers, setPlanMode, showNotice]);

	useEffect(() => {
		if (initialPrompt) {
			void submitRef.current(initialPrompt);
		}
	}, [initialPrompt]);

	useEffect(() => {
		if (initialPrompt || !isReleaseInstall()) return;
		fetchLatestVersion()
			.then((latest) => {
				if (latest && isNewerVersion(version, latest)) {
					showNotice(`[cast v${latest} available — run "cast upgrade" to update]`);
				}
			})
			.catch(() => {});
	}, [version, initialPrompt, showNotice]);

	useEffect(() => {
		// Don't dismiss out from under an open modal — e.g. the trust prompt's
		// explanation shouldn't vanish while the user is still deciding.
		if (!notice || modalRequest) return;
		const duration = noticeDurationRef.current;
		if (duration <= 0) return;
		const id = setTimeout(() => setNotice(null), duration);
		return () => clearTimeout(id);
	}, [notice, modalRequest]);

	// Stable deps ref — handleInput reads the latest values at call time
	// instead of recreating handleSubmit on every state change.
	const depsRef = useRef({
		agent,
		session,
		config,
		running,
		onQuit,
		showNotice,
		cwd,
		setCwd,
		currentPersona,
		setCurrentPersona,
		skills,
		setSkills,
		skillsPromptSuffix,
		setSkillsPromptSuffix,
		contextFilesSuffix,
		setContextFilesSuffix,
		rulesSuffix,
		setRulesSuffix,
		rulesLazySuffix,
		setRulesLazySuffix,
		directoryRules,
		setDirectoryRules,
		activeAutoRules,
		setActiveAutoRules,
		systemPrompt,
		setSystemPrompt,
		mcpResult,
		setMcpResult,
		permissionMode,
		setPermissionMode,
		projectTrusted,
		setProjectTrusted,
		projectDeps,
		pickers,
		reasoningMeta,
		setReasoningMeta,
		personaOptions,
		setPersonaOptions,
		subagentModel,
		setSubagentModel,
		webToolsEnabled,
		setWebToolsEnabled,
		planMode,
		setPlanMode,
		onThemeChange,
	});
	depsRef.current = {
		agent,
		session,
		config,
		running,
		onQuit,
		showNotice,
		cwd,
		setCwd,
		currentPersona,
		setCurrentPersona,
		skills,
		setSkills,
		skillsPromptSuffix,
		setSkillsPromptSuffix,
		contextFilesSuffix,
		setContextFilesSuffix,
		rulesSuffix,
		setRulesSuffix,
		rulesLazySuffix,
		setRulesLazySuffix,
		directoryRules,
		setDirectoryRules,
		activeAutoRules,
		setActiveAutoRules,
		systemPrompt,
		setSystemPrompt,
		mcpResult,
		setMcpResult,
		permissionMode,
		setPermissionMode,
		projectTrusted,
		setProjectTrusted,
		projectDeps,
		pickers,
		reasoningMeta,
		setReasoningMeta,
		personaOptions,
		setPersonaOptions,
		subagentModel,
		setSubagentModel,
		webToolsEnabled,
		setWebToolsEnabled,
		planMode,
		setPlanMode,
		onThemeChange,
	};

	const handleSubmit = useCallback(async (text: string) => {
		await handleInput(text, undefined, depsRef.current);
	}, []);

	return (
		<Box flexDirection="column">
			<ChatLog
				messages={agent.messages}
				streaming={agent.streaming}
				error={agent.error}
				retry={agent.retry}
				repaintKey={repaintKey + _themeVer}
			/>
			{notice && <Text color={theme().warning}>{notice}</Text>}
			{modalRequest?.kind === "option" && (
				<ModalPicker
					options={modalRequest.options}
					opts={modalRequest.opts}
					onSelect={modalRequest.resolve}
					onCancel={() => modalRequest.resolve(null)}
				/>
			)}
			{modalRequest?.kind === "text" && (
				<TextInputModal
					label={modalRequest.label}
					defaultValue={modalRequest.defaultValue}
					placeholder={modalRequest.placeholder}
					error={modalRequest.error}
					onSubmit={modalRequest.resolve}
					onCancel={() => modalRequest.resolve(null)}
				/>
			)}
			{modalRequest?.kind === "status" && (
				<Box>
					<Spinner />
					<Text> {modalRequest.label}</Text>
				</Box>
			)}
			{/* Stays up for as long as the message is actually queued — not a
			    timed toast, since a tool-heavy turn can take much longer than a
			    fixed timeout to reach the point where the queue gets drained.
			    Lists every pending entry (not just the latest) so queuing
			    several /steer or /queue messages before the turn catches up to
			    them doesn't silently hide all but the last one. */}
			{agent.pendingSteers.map((text, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: FIFO queue, no stable identity
				<Text key={`steer-${i}`} color={theme().warning}>
					[Steer queued{agent.pendingSteers.length > 1 ? ` (${i + 1}/${agent.pendingSteers.length})` : ""}:{" "}
					{text.slice(0, 60)}]
				</Text>
			))}
			{agent.pendingQueue.map((text, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: FIFO queue, no stable identity
				<Text key={`queue-${i}`} color={theme().warning}>
					[Queued{agent.pendingQueue.length > 1 ? ` (${i + 1}/${agent.pendingQueue.length})` : ""}:{" "}
					{text.slice(0, 60)}]
				</Text>
			))}
			<Composer
				onSubmit={(text) => {
					void handleSubmit(text);
				}}
				canSubmit={canSubmit}
				onAbort={agent.abort}
				onExit={onQuit}
				onPasteImage={onPasteImage}
				running={running}
				locked={modalRequest !== null}
			/>
			{/* Status bar lives under the input frame, not above the screen —
			    matches Claude Code's own layout instead of a top-of-terminal
			    banner that scrolls out of view as the conversation grows.
			    Usage is the session's running total (not per-message — that
			    got noisy fast), right-aligned on the same row. */}
			<Box justifyContent="space-between">
				<Text color={theme().muted} dimColor>
					<Text color={theme().persona}>{currentPersona.label}</Text>
					{/* Mode is always visible: plan mode shouts (warning color, it
					    changes what the agent may do), build stays quiet. */}
					{planMode ? <Text color={theme().warning}> [PLAN]</Text> : <Text color={theme().muted}> [BUILD]</Text>}
					<Text color={theme().muted}> │ </Text>
					<Text color={theme().muted}>{session.model}</Text>
					{/* Zero-width marker toggled by the resize effect. After that effect
					    clears the screen, Ink's log-update would otherwise skip redrawing
					    an *unchanged* frame — leaving a blank screen on an empty session
					    (no <Static> reprint to force a write). Flipping this width-0 char
					    changes the frame string so the redraw always happens. */}
					{repaintKey % 2 === 1 ? "\u200b" : null}
				</Text>
				{((agent.usage && agent.usage.totalTokens > 0) || agent.elapsedMs > 0) && (
					<Text color={theme().muted} dimColor>
						{agent.usage && agent.usage.totalTokens > 0
							? formatUsageTotals(agent.usage, agent.lastTurnUsage, session.messages, config, agent.elapsedMs)
							: agent.elapsedMs > 0
								? fmtElapsed(agent.elapsedMs)
								: ""}
					</Text>
				)}
			</Box>
		</Box>
	);
}

/**
 * Compact token count for the status line: 736 stays, 8,736 → "8.7k",
 * 1,200,000 → "1.2M". One decimal, trailing ".0" dropped (8,000 → "8k").
 * Under the composer the exact digits don't matter — the magnitude does — and
 * the short form keeps the line from wrapping.
 */
export function abbreviateTokens(n: number): string {
	if (n < 1000) return String(n);
	// 999,950+ would round to "1000.0k" — hand those to the M branch so it reads
	// "1M" instead.
	if (n < 999_950) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

const fmtElapsed = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

function formatUsageTotals(
	usage: SessionUsage,
	lastTurnUsage: UseAgentSession["lastTurnUsage"],
	messages: import("../core/llm.ts").Message[],
	config: AppConfig,
	elapsedMs: number,
): string {
	const cacheStr =
		(usage.cacheReadTokens || usage.cacheWriteTokens) && usage.promptTokens > 0
			? ` (${Math.round((usage.cacheReadTokens / usage.promptTokens) * 100)}% cached)`
			: "";
	const tpsStr = lastTurnUsage?.tokensPerSecond ? ` │ ${lastTurnUsage.tokensPerSecond.toFixed(1)} tok/s` : "";
	const turnStr = elapsedMs > 0 ? ` │ ${fmtElapsed(elapsedMs)}` : "";
	const subStr = usage.subagentTokens > 0 ? ` │ ${abbreviateTokens(usage.subagentTokens)} sub` : "";
	const ctxStr = formatContextPct(messages, config);
	return `${abbreviateTokens(usage.promptTokens)} in${cacheStr} / ${abbreviateTokens(usage.completionTokens)} out │ ${ctxStr}${tpsStr}${turnStr}${subStr}`;
}

export function formatContextPct(messages: import("../core/llm.ts").Message[], config: AppConfig): string {
	const used = estimateTokens(messages);
	const budget = config.contextWindow - config.maxResponseTokens;
	if (budget <= 0) return "ctx ?";
	const pct = Math.round((used / budget) * 100);
	return `ctx ${abbreviateTokens(used)}/${abbreviateTokens(config.contextWindow)} (${pct}%)`;
}
