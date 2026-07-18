import { Text } from "ink";
import type { JSX } from "react";
import type { SessionUsage } from "../core/session.ts";
import { estimateTokens } from "../core/session.ts";
import type { StatusBarConfig } from "../core/settings.ts";
import { abbreviateTokens } from "./App.tsx";
import { theme } from "./themes/index.ts";

// ============================================================================
// Segment context — data passed to every segment's render function
// ============================================================================

export interface SegmentContext {
	persona: string;
	planMode: boolean;
	/** Model actually in use right now: the plan override when plan mode is on
	 * with one, otherwise the configured model. */
	activeModel: string;
	/** The configured model — stays the same across plan/build toggles, so
	 * /current can show when the live model diverges from it. */
	configuredModel: string;
	/** Plan-mode override (when set, used while plan mode is on). Undefined
	 * when no override is configured. */
	planModel: string | undefined;
	usage: SessionUsage | undefined;
	lastTurnUsage: { tokensPerSecond?: number } | undefined;
	elapsedMs: number;
	messageCount: number;
	contextWindow: number;
	maxResponseTokens: number;
	messages: import("../core/llm.ts").Message[];
	sessionId: string;
}

// ============================================================================
// Segment descriptor
// ============================================================================

export interface StatusBarSegment {
	id: string;
	label: string;
	defaultOn: boolean;
	side: "left" | "right";
	render: (ctx: SegmentContext) => JSX.Element | null;
	/**
	 * Plain-text rendering of this segment's data for the /current command.
	 * Returning null means "no data" and the command prints an em-dash, the
	 * same default it used when the segment wasn't recognized. The visible
	 * status bar uses `render`; this is only read by /current.
	 */
	formatValue: (ctx: SegmentContext) => string | null;
}

const segments: StatusBarSegment[] = [];

export function registerStatusBarSegment(seg: StatusBarSegment): void {
	segments.push(seg);
}

export function getStatusBarSegments(): readonly StatusBarSegment[] {
	return segments;
}

/** Default config derived from registry defaults. */
export function defaultStatusBarConfig(): StatusBarConfig {
	const all = getStatusBarSegments();
	return {
		visible: all.filter((s) => s.defaultOn).map((s) => s.id),
		order: all.map((s) => s.id),
		sides: Object.fromEntries(all.map((s) => [s.id, s.side])),
	};
}

// Width estimates for overflow warning (worst-case typical widths).
export const SEGMENT_MAX_WIDTH: Record<string, number> = {
	persona: 20,
	mode: 8,
	model: 30,
	session: 16,
	context: 22,
	usage: 35,
	speed: 12,
	elapsed: 7,
	subagent: 9,
};

// ============================================================================
// Core segment registrations
// ============================================================================

registerStatusBarSegment({
	id: "persona",
	label: "Persona",
	defaultOn: true,
	side: "left",
	render: (ctx) => <Text color={theme().persona}>{ctx.persona}</Text>,
	formatValue: (ctx) => ctx.persona,
});

registerStatusBarSegment({
	id: "mode",
	label: "Mode",
	defaultOn: true,
	side: "left",
	render: (ctx) =>
		ctx.planMode ? <Text color={theme().warning}>PLAN</Text> : <Text color={theme().muted}>BUILD</Text>,
	formatValue: (ctx) => (ctx.planMode ? "PLAN" : "BUILD"),
});

registerStatusBarSegment({
	id: "model",
	label: "Model",
	defaultOn: true,
	side: "left",
	render: (ctx) => <Text color={theme().muted}>{ctx.activeModel}</Text>,
	// When plan mode swaps in a separate plan model, /current shows the
	// configured model and tags the live one in parens — otherwise the
	// status bar reads one model and the user wonders where the other came from.
	formatValue: (ctx) => {
		if (ctx.planMode && ctx.planModel && ctx.planModel !== ctx.configuredModel) {
			return `${ctx.configuredModel} (plan: ${ctx.activeModel})`;
		}
		return ctx.activeModel;
	},
});

registerStatusBarSegment({
	id: "session",
	label: "Session",
	defaultOn: false,
	side: "left",
	render: (ctx) => <Text color={theme().muted}>{ctx.sessionId}</Text>,
	formatValue: (ctx) => ctx.sessionId,
});

registerStatusBarSegment({
	id: "context",
	label: "Context %",
	defaultOn: false,
	side: "right",
	render: (ctx) => {
		if (ctx.messages.length === 0) return null;
		const used = estimateTokens(ctx.messages);
		const budget = ctx.contextWindow - ctx.maxResponseTokens;
		if (budget <= 0) return <Text color={theme().muted}>ctx ?</Text>;
		const pct = Math.round((used / budget) * 100);
		return (
			<Text color={theme().muted}>
				ctx {abbreviateTokens(used)}/{abbreviateTokens(ctx.contextWindow)} ({pct}%)
			</Text>
		);
	},
	formatValue: (ctx) => {
		if (ctx.messages.length === 0) return null;
		const used = estimateTokens(ctx.messages);
		const budget = ctx.contextWindow - ctx.maxResponseTokens;
		if (budget <= 0) return "ctx ?";
		const pct = Math.round((used / budget) * 100);
		return `ctx ${abbreviateTokens(used)}/${abbreviateTokens(ctx.contextWindow)} (${pct}%)`;
	},
});

registerStatusBarSegment({
	id: "usage",
	label: "Tokens in/out",
	defaultOn: false,
	side: "right",
	render: (ctx) => {
		if (!ctx.usage || ctx.usage.totalTokens <= 0) return null;
		const cacheStr =
			(ctx.usage.cacheReadTokens || ctx.usage.cacheWriteTokens) && ctx.usage.promptTokens > 0
				? ` (${Math.round((ctx.usage.cacheReadTokens / ctx.usage.promptTokens) * 100)}% cached)`
				: "";
		return (
			<Text color={theme().muted}>
				{abbreviateTokens(ctx.usage.promptTokens)} in{cacheStr} / {abbreviateTokens(ctx.usage.completionTokens)} out
			</Text>
		);
	},
	formatValue: (ctx) => {
		const u = ctx.usage;
		if (!u || u.totalTokens <= 0) return null;
		return `${abbreviateTokens(u.promptTokens)} in / ${abbreviateTokens(u.completionTokens)} out`;
	},
});

registerStatusBarSegment({
	id: "speed",
	label: "Tok/s",
	defaultOn: false,
	side: "right",
	render: (ctx) => {
		if (!ctx.lastTurnUsage?.tokensPerSecond) return null;
		return <Text color={theme().muted}>{ctx.lastTurnUsage.tokensPerSecond.toFixed(1)} tok/s</Text>;
	},
	formatValue: (ctx) => {
		const tps = ctx.lastTurnUsage?.tokensPerSecond;
		return tps ? `${tps.toFixed(1)} tok/s` : null;
	},
});

registerStatusBarSegment({
	id: "elapsed",
	label: "Elapsed",
	defaultOn: true,
	side: "right",
	render: (ctx) => {
		if (ctx.elapsedMs <= 0) return null;
		return <Text color={theme().muted}>{(ctx.elapsedMs / 1000).toFixed(1)}s</Text>;
	},
	formatValue: (ctx) => (ctx.elapsedMs > 0 ? `${(ctx.elapsedMs / 1000).toFixed(1)}s` : null),
});

registerStatusBarSegment({
	id: "subagent",
	label: "Subagent tokens",
	defaultOn: false,
	side: "right",
	render: (ctx) => {
		if (!ctx.usage || ctx.usage.subagentTokens <= 0) return null;
		return <Text color={theme().muted}>{abbreviateTokens(ctx.usage.subagentTokens)} sub</Text>;
	},
	formatValue: (ctx) => {
		const u = ctx.usage;
		return u && u.subagentTokens > 0 ? `${abbreviateTokens(u.subagentTokens)} sub` : null;
	},
});
