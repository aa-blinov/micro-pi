import { describe, expect, it } from "vitest";
import { createDesyncTracker, createFocusReturnTracker } from "../src/ui/useTerminalResync.ts";

// A focus resync clears the screen (banner included, since it lives outside
// Ink's <Static>), so it must fire ONLY on a genuine alt-tab return — never on
// the spurious focus-in a terminal emits when focus reporting is first enabled.
describe("createFocusReturnTracker", () => {
	const IN = "\x1b[I";
	const OUT = "\x1b[O";

	it("ignores a focus-in with no preceding focus-out (the startup event)", () => {
		const t = createFocusReturnTracker();
		expect(t.onData(IN)).toBe(false);
	});

	it("fires on a focus-in that follows a focus-out (real alt-tab return)", () => {
		const t = createFocusReturnTracker();
		expect(t.onData(OUT)).toBe(false); // left the window
		expect(t.onData(IN)).toBe(true); // came back
	});

	it("does not re-fire on a repeated focus-in without another focus-out", () => {
		const t = createFocusReturnTracker();
		t.onData(OUT);
		expect(t.onData(IN)).toBe(true);
		expect(t.onData(IN)).toBe(false); // duplicate report — ignored
	});

	it("handles out+in arriving in a single chunk", () => {
		const t = createFocusReturnTracker();
		expect(t.onData(`${OUT}${IN}`)).toBe(true);
	});

	it("ignores unrelated input", () => {
		const t = createFocusReturnTracker();
		expect(t.onData("hello")).toBe(false);
	});
});

// The cleanup repaint (clear + full <Static> replay) is expensive, so the
// tracker must request it ONLY when a streaming turn actually stacked frames —
// never speculatively on an ordinary turn. These tests pin that guarantee.
describe("createDesyncTracker", () => {
	it("does not request a repaint for a turn whose frames all fit the viewport", () => {
		const t = createDesyncTracker(false);
		// A normal turn: start streaming, several fitting frames, then settle.
		t.onPoll(true); // streaming begins
		t.noteFrame(true, true);
		t.noteFrame(true, true);
		expect(t.onPoll(false)).toBe(false); // settle — no desync seen, no repaint
	});

	it("requests exactly one repaint when the live area outgrew the viewport mid-stream", () => {
		const t = createDesyncTracker(false);
		t.onPoll(true); // streaming
		t.noteFrame(true, true); // fits
		t.noteFrame(false, true); // taller than viewport → arm
		t.noteFrame(true, true); // fits again — stays armed
		expect(t.onPoll(false)).toBe(true); // settle → one cleanup repaint
	});

	it("fires the repaint once, not on every idle poll after settling", () => {
		const t = createDesyncTracker(false);
		t.onPoll(true);
		t.noteFrame(false, true);
		expect(t.onPoll(false)).toBe(true); // the edge
		expect(t.onPoll(false)).toBe(false); // subsequent idle polls: nothing
		expect(t.onPoll(false)).toBe(false);
	});

	it("ignores a tall frame seen while NOT streaming (only streaming stacks)", () => {
		const t = createDesyncTracker(false);
		t.noteFrame(false, false); // tall, but idle — not the stacking case
		expect(t.onPoll(false)).toBe(false);
	});

	it("re-arms independently for a later turn after a clean one", () => {
		const t = createDesyncTracker(false);
		// Turn 1: clean.
		t.onPoll(true);
		t.noteFrame(true, true);
		expect(t.onPoll(false)).toBe(false);
		// Turn 2: stacks → must request its own repaint.
		t.onPoll(true);
		t.noteFrame(false, true);
		expect(t.onPoll(false)).toBe(true);
	});

	it("does not treat staying-in-streaming as an edge", () => {
		const t = createDesyncTracker(false);
		t.onPoll(true);
		t.noteFrame(false, true);
		expect(t.onPoll(true)).toBe(false); // still streaming — not settled yet
		expect(t.onPoll(false)).toBe(true); // now it settles
	});
});
