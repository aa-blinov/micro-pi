import { Box, Text } from "ink";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { makeConfirmBash } from "../core/project.ts";
import type { SessionUsage } from "../core/session.ts";
import type { StartupResult } from "../core/startup.ts";
import { fetchLatestVersion, isNewerVersion, isReleaseInstall } from "../core/upgrade.ts";
import { ModalPicker, TextInputModal } from "../pickers/ink.tsx";
import { ChatLog } from "./ChatLog.tsx";
import { Composer } from "./Composer.tsx";
import { canSubmitDuringRun, handleInput } from "./commands.ts";
import { gradientHex } from "./gradient.ts";
import { useModalBridge } from "./pickerBridge.ts";
import { type UseAgentSession, useAgentSession } from "./useAgentSession.ts";

/** Midpoint of the banner/loader/border palette — distinct from user (cyan end) and agent (violet end). */
const PERSONA_COLOR = gradientHex(0.5);

interface AppProps {
	result: StartupResult;
	version: string;
	initialPrompt?: string;
	onPasteImage?: () => Promise<string | null>;
	onQuit: () => void;
}

export function App(props: AppProps): JSX.Element {
	const { result, version, initialPrompt, onQuit, onPasteImage } = props;
	const { config, runner } = result;

	const [notice, setNotice] = useState<string | null>(null);
	const showNotice = useCallback((text: string) => setNotice(text), []);

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
	const [permissionMode, setPermissionMode] = useState(result.permissionMode);
	const [projectTrusted, setProjectTrusted] = useState(result.projectTrusted);
	const [cwd, setCwd] = useState(result.cwd);
	const [reasoningMeta, setReasoningMeta] = useState(result.reasoningMeta);

	const confirmBash = useMemo(() => makeConfirmBash(pickers, permissionMode), [pickers, permissionMode]);

	const agent = useAgentSession({
		session,
		config,
		cwd,
		systemPrompt,
		runner,
		permissionMode,
		mcpResult,
		confirmBash,
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
		const id = setTimeout(() => setNotice(null), 6000);
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
	};

	const handleSubmit = useCallback(async (text: string) => {
		await handleInput(text, undefined, depsRef.current);
	}, []);

	return (
		<Box flexDirection="column">
			<ChatLog messages={agent.messages} streaming={agent.streaming} error={agent.error} retry={agent.retry} />
			{notice && <Text color="yellow">{notice}</Text>}
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
					onSubmit={modalRequest.resolve}
					onCancel={() => modalRequest.resolve(null)}
				/>
			)}
			{/* Stays up for as long as the message is actually queued — not a
			    timed toast, since a tool-heavy turn can take much longer than a
			    fixed timeout to reach the point where the queue gets drained.
			    Lists every pending entry (not just the latest) so queuing
			    several /steer or /queue messages before the turn catches up to
			    them doesn't silently hide all but the last one. */}
			{agent.pendingSteers.map((text, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: FIFO queue, no stable identity
				<Text key={`steer-${i}`} color="yellow">
					[Steer queued{agent.pendingSteers.length > 1 ? ` (${i + 1}/${agent.pendingSteers.length})` : ""}:{" "}
					{text.slice(0, 60)}]
				</Text>
			))}
			{agent.pendingQueue.map((text, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: FIFO queue, no stable identity
				<Text key={`queue-${i}`} color="yellow">
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
				<Text color="gray" dimColor>
					<Text color={PERSONA_COLOR}>{currentPersona.label}</Text>
					<Text color="gray"> · </Text>
					<Text>{session.model}</Text>
					<Text color="gray"> · </Text>
					<Text>reasoning: {config.reasoningLevel}</Text>
					<Text color="gray"> · </Text>
					<Text>session: {session.id.slice(0, 8)}</Text>
					{permissionMode === "bypass" ? (
						<>
							<Text color="gray"> · </Text>
							<Text color="red">bypass</Text>
						</>
					) : null}
				</Text>
				{agent.usage && agent.usage.totalTokens > 0 && (
					<Text color="gray" dimColor>
						{formatUsageTotals(agent.usage, agent.lastTurnUsage)}
					</Text>
				)}
			</Box>
		</Box>
	);
}

function formatUsageTotals(usage: SessionUsage, lastTurnUsage: UseAgentSession["lastTurnUsage"]): string {
	const cacheStr =
		usage.cacheReadTokens || usage.cacheWriteTokens
			? ` (${usage.uncachedTokens.toLocaleString()} uncached + ${usage.cacheReadTokens.toLocaleString()} cached)`
			: "";
	const costStr = usage.cost ? ` · $${usage.cost.toFixed(4)}` : "";
	// Last request's throughput, not a cumulative/session average — a session
	// average would blend in all the idle time between turns (user typing,
	// tool execution, etc.), which isn't what "how fast is the model
	// responding right now" is asking.
	const tpsStr = lastTurnUsage?.tokensPerSecond ? ` · ${lastTurnUsage.tokensPerSecond.toFixed(1)} tok/s` : "";
	return `${usage.promptTokens.toLocaleString()} in${cacheStr} / ${usage.completionTokens.toLocaleString()} out${costStr}${tpsStr}`;
}
