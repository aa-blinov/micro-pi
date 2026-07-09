import { describe, expect, it } from "vitest";
import { StdinBuffer } from "../src/ui/input/stdin-buffer.ts";

// Collect emitted "data" and "paste" events for inspection.
function harness(opts?: { pasteTimeout?: number }) {
	const buf = new StdinBuffer({ pasteTimeout: opts?.pasteTimeout });
	const data: string[] = [];
	const pastes: string[] = [];
	buf.on("data", (s) => data.push(s));
	buf.on("paste", (s) => pastes.push(s));
	return {
		buf,
		data,
		pastes,
		process: (s: string) => buf.process(s),
		flushTimers: () => new Promise((r) => setTimeout(r, 60)),
	};
}

describe("StdinBuffer — plain-paste burst detection", () => {
	it("does NOT swallow a typed line + Enter batched into one chunk", async () => {
		const h = harness();
		// Fast typing where "hello" + Enter lands as a single read() batch.
		// The newline is the LAST char (no interior newline), so this must not
		// start a paste accumulation — Enter should flow through as a \r data
		// event so the keybinder matches input.submit.
		h.process("hello\r");
		await h.flushTimers();
		expect(h.pastes).toEqual([]);
		// Each character (including \r) emitted as its own data event.
		expect(h.data.join("")).toBe("hello\r");
	});

	it("does NOT swallow a bare Enter", async () => {
		const h = harness();
		h.process("\r");
		await h.flushTimers();
		expect(h.pastes).toEqual([]);
		expect(h.data).toEqual(["\r"]);
	});

	it("detects a genuine two-line paste with no trailing newline", async () => {
		const h = harness();
		h.process("line1\nline2");
		await h.flushTimers();
		expect(h.pastes).toEqual(["line1\nline2"]);
		expect(h.data).toEqual([]);
	});

	it("detects a multi-line paste with a trailing newline", async () => {
		const h = harness();
		h.process("a\nb\nc\n");
		await h.flushTimers();
		expect(h.pastes).toEqual(["a\nb\nc\n"]);
		expect(h.data).toEqual([]);
	});

	it("detects a paste that starts with a blank line", async () => {
		const h = harness();
		h.process("\nfoo");
		await h.flushTimers();
		expect(h.pastes).toEqual(["\nfoo"]);
	});

	it("coalesces consecutive chunks of one large unwrapped paste into one event", async () => {
		const h = harness();
		// A real paste big enough to span multiple reads, split mid-stream.
		h.process("line1\nline2\nline3");
		h.process("\nline4\nline5");
		await h.flushTimers();
		expect(h.pastes).toEqual(["line1\nline2\nline3\nline4\nline5"]);
	});
});

describe("StdinBuffer — bracketed paste timeout", () => {
	it("normal bracketed paste still works", async () => {
		const h = harness();
		h.process("\x1b[200~hello world\x1b[201~");
		expect(h.pastes).toEqual(["hello world"]);
		expect(h.data).toEqual([]);
	});

	it("exits pasteMode after timeout when end marker never arrives", async () => {
		const h = harness({ pasteTimeout: 100 });
		h.process("\x1b[200~stuck content");
		expect(h.pastes).toEqual([]);
		await new Promise((r) => setTimeout(r, 150));
		expect(h.pastes).toEqual(["stuck content"]);
		// After timeout, stdin is functional again.
		h.process("ok");
		expect(h.data.join("")).toBe("ok");
	});

	it("timeout is cleaned up on clear()", async () => {
		const h = harness();
		h.process("\x1b[200~partial");
		h.buf.clear();
		h.process("after");
		expect(h.data.join("")).toBe("after");
		expect(h.pastes).toEqual([]);
	});
});
