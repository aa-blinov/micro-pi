import { Box, Text, useApp } from "ink";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppConfig } from "../core/config.ts";
import { formatContextFilesForPrompt, resolveNestedContextFiles } from "../core/context-files.ts";
import { buildSystemPrompt, makeConfirmBash } from "../core/project.ts";
import {
	formatRulesForTurn,
	matchAutoRules,
	type Rule,
	selectMentionedRules,
	unionStickyRules,
} from "../core/rules.ts";
import type { SessionUsage } from "../core/session.ts";
import { estimateTokens } from "../core/session.ts";
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
	const disabledTools = useMemo(() => {
		const s = new Set<string>();
		if (!webToolsEnabled) {
			s.add("web_search");
			s.add("web_fetch");
		}
		return s;
	}, [webToolsEnabled]);
	// Theme change counter — forces a re-render when /theme switches the active
	// theme, since theme() reads from a module-level singleton that Ink can't
	// detect on its own.
	const [_themeVer, setThemeVer] = useState(0);
	const onThemeChange = useCallback(() => {
		setThemeVer((v) => v + 1);
		void onRepaintBanner?.();
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
				{ model: session.model, reasoningLevel: config.reasoningLevel },
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
