import { describe, expect, it } from "vitest";
import type { Message } from "../src/core/llm.ts";
import {
	defaultStatusBarConfig,
	getStatusBarSegments,
	SEGMENT_MAX_WIDTH,
	type SegmentContext,
} from "../src/ui/statusbar.tsx";

/** Empty-but-valid SegmentContext for the null-on-empty-data tests. */
function emptyCtx(overrides: Partial<SegmentContext> = {}): SegmentContext {
	return {
		persona: "Coding",
		planMode: false,
		activeModel: "m",
		configuredModel: "m",
		planModel: undefined,
		usage: undefined,
		lastTurnUsage: undefined,
		elapsedMs: 0,
		messageCount: 0,
		contextWindow: 128_000,
		maxResponseTokens: 8192,
		messages: [] as Message[],
		sessionId: "test-session",
		...overrides,
	};
}

describe("defaultStatusBarConfig", () => {
	it("lists only defaultOn segments as visible, in registration order", () => {
		const cfg = defaultStatusBarConfig();
		const allIds = getStatusBarSegments().map((s) => s.id);
		const defaultOnIds = getStatusBarSegments()
			.filter((s) => s.defaultOn)
			.map((s) => s.id);

		// Visible: every defaultOn id, no more, no less, in registration order.
		expect(cfg.visible).toEqual(defaultOnIds);

		// Order: every registered id, in registration order (matches the registry
		// so the picker initial layout matches the default).
		expect(cfg.order).toEqual(allIds);

		// Sides: every id has an entry, and it matches the segment's default side.
		for (const seg of getStatusBarSegments()) {
			expect(cfg.sides[seg.id]).toBe(seg.side);
		}
	});
});

describe("SEGMENT_MAX_WIDTH", () => {
	it("has an entry for every registered segment id (catches forgotten entries)", () => {
		for (const seg of getStatusBarSegments()) {
			expect(SEGMENT_MAX_WIDTH[seg.id]).toBeDefined();
		}
	});
});

describe("segment renderers", () => {
	it("usage returns null when there's no usage", () => {
		const seg = getStatusBarSegments().find((s) => s.id === "usage")!;
		expect(seg.render(emptyCtx())).toBeNull();
	});

	it("usage returns null when totalTokens is zero", () => {
		const seg = getStatusBarSegments().find((s) => s.id === "usage")!;
		const usage = {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cost: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			uncachedTokens: 0,
			subagentTokens: 0,
		};
		expect(seg.render(emptyCtx({ usage }))).toBeNull();
	});

	it("subagent returns null when subagentTokens is zero", () => {
		const seg = getStatusBarSegments().find((s) => s.id === "subagent")!;
		const usage = {
			promptTokens: 100,
			completionTokens: 50,
			totalTokens: 150,
			cost: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			uncachedTokens: 100,
			subagentTokens: 0,
		};
		expect(seg.render(emptyCtx({ usage }))).toBeNull();
	});

	it("elapsed returns null when elapsedMs is zero or negative", () => {
		const seg = getStatusBarSegments().find((s) => s.id === "elapsed")!;
		expect(seg.render(emptyCtx({ elapsedMs: 0 }))).toBeNull();
		expect(seg.render(emptyCtx({ elapsedMs: -1 }))).toBeNull();
	});

	it("elapsed renders a positive elapsedMs as a non-null element", () => {
		const seg = getStatusBarSegments().find((s) => s.id === "elapsed")!;
		expect(seg.render(emptyCtx({ elapsedMs: 1500 }))).not.toBeNull();
	});

	it("session is off by default, left-aligned, and renders the sessionId", () => {
		const seg = getStatusBarSegments().find((s) => s.id === "session")!;
		expect(seg.defaultOn).toBe(false);
		expect(seg.side).toBe("left");
		const ctx = emptyCtx({ sessionId: "abc123" });
		expect(seg.render(ctx)).not.toBeNull();
		expect(seg.formatValue(ctx)).toBe("abc123");
		// Registered after `model`, before `context` — keeps the default order "model | session | …".
		const ids = getStatusBarSegments().map((s) => s.id);
		expect(ids.indexOf("session")).toBe(ids.indexOf("model") + 1);
		expect(ids.indexOf("session")).toBeLessThan(ids.indexOf("context"));
	});
});

describe("segment formatValue (/current)", () => {
	it("model shows configured + active on separate lines when plan mode swaps the model", () => {
		const seg = getStatusBarSegments().find((s) => s.id === "model")!;
		const value = seg.formatValue(
			emptyCtx({
				planMode: true,
				planModel: "opus",
				configuredModel: "haiku",
				activeModel: "opus",
			}),
		);
		expect(value).toBe("haiku (plan: opus)");
	});

	it("model collapses to activeModel when no plan override is in effect", () => {
		const seg = getStatusBarSegments().find((s) => s.id === "model")!;
		const value = seg.formatValue(
			emptyCtx({
				planMode: true,
				planModel: undefined,
				configuredModel: "haiku",
				activeModel: "haiku",
			}),
		);
		expect(value).toBe("haiku");
	});

	it("usage and subagent return null when there's nothing to show", () => {
		const usage = getStatusBarSegments().find((s) => s.id === "usage")!;
		const subagent = getStatusBarSegments().find((s) => s.id === "subagent")!;
		expect(usage.formatValue(emptyCtx())).toBeNull();
		expect(subagent.formatValue(emptyCtx())).toBeNull();
	});
});
