/**
 * StdinBuffer — ported from pi's packages/tui/src/stdin-buffer.ts.
 *
 * Buffers stdin data and emits only complete escape sequences. Partial
 * sequences that arrive across multiple chunks are accumulated until they
 * form a valid sequence (or a 10ms timeout flushes them as-is).
 *
 * Bracketed paste payloads are emitted as separate "paste" events so the
 * caller can handle them distinctly from key presses.
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui), MIT.
 */

import { EventEmitter } from "node:events";

const ESC = "\x1b";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function isCompleteSequence(data: string): "complete" | "incomplete" | "not-escape" {
	if (!data.startsWith(ESC)) return "not-escape";
	if (data.length === 1) return "incomplete";
	const afterEsc = data.slice(1);

	if (afterEsc.startsWith("[")) {
		if (afterEsc.startsWith("[M")) return data.length >= 6 ? "complete" : "incomplete";
		return isCompleteCsiSequence(data);
	}
	if (afterEsc.startsWith("]")) return isCompleteOscSequence(data);
	if (afterEsc.startsWith("P")) return isCompleteDcsSequence(data);
	if (afterEsc.startsWith("_")) return isCompleteApcSequence(data);
	if (afterEsc.startsWith("O")) return afterEsc.length >= 2 ? "complete" : "incomplete";
	if (afterEsc.length === 1) return "complete";
	return "complete";
}

function isCompleteCsiSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}[`)) return "complete";
	if (data.length < 3) return "incomplete";
	const payload = data.slice(2);
	const lastChar = payload[payload.length - 1];
	const lastCharCode = lastChar.charCodeAt(0);
	if (lastCharCode >= 0x40 && lastCharCode <= 0x7e) {
		if (payload.startsWith("<")) {
			if (/^<\d+;\d+;\d+[Mm]$/.test(payload)) return "complete";
			if (lastChar === "M" || lastChar === "m") {
				const parts = payload.slice(1, -1).split(";");
				if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) return "complete";
			}
			return "incomplete";
		}
		return "complete";
	}
	return "incomplete";
}

function isCompleteOscSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}]`)) return "complete";
	if (data.endsWith(`${ESC}\\`) || data.endsWith("\x07")) return "complete";
	return "incomplete";
}

function isCompleteDcsSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}P`)) return "complete";
	if (data.endsWith(`${ESC}\\`)) return "complete";
	return "incomplete";
}

function isCompleteApcSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}_`)) return "complete";
	if (data.endsWith(`${ESC}\\`)) return "complete";
	return "incomplete";
}

function parseUnmodifiedKittyPrintableCodepoint(sequence: string): number | undefined {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
	const match = sequence.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/);
	if (!match) return undefined;
	const codepoint = parseInt(match[1]!, 10);
	return codepoint >= 32 ? codepoint : undefined;
}

function extractCompleteSequences(buffer: string): { sequences: string[]; remainder: string } {
	const sequences: string[] = [];
	let pos = 0;

	while (pos < buffer.length) {
		const remaining = buffer.slice(pos);

		if (remaining.startsWith(ESC)) {
			let seqEnd = 1;
			while (seqEnd <= remaining.length) {
				const candidate = remaining.slice(0, seqEnd);
				const status = isCompleteSequence(candidate);

				if (status === "complete") {
					if (candidate === "\x1b\x1b") {
						const nextChar = remaining[seqEnd];
						if (
							nextChar === "[" ||
							nextChar === "]" ||
							nextChar === "O" ||
							nextChar === "P" ||
							nextChar === "_"
						) {
							sequences.push(ESC);
							pos += 1;
							break;
						}
					}
					sequences.push(candidate);
					pos += seqEnd;
					break;
				} else if (status === "incomplete") {
					seqEnd++;
				} else {
					sequences.push(candidate);
					pos += seqEnd;
					break;
				}
			}
			if (seqEnd > remaining.length) return { sequences, remainder: remaining };
		} else {
			sequences.push(remaining[0]!);
			pos++;
		}
	}
	return { sequences, remainder: "" };
}

export type StdinBufferEventMap = {
	data: [string];
	paste: [string];
};

// A single terminal write() big enough to need bracketed-paste at all
// routinely exceeds one pty read()'s buffer size, so it lands as several
// separate `process()` calls even when the terminal *did* wrap it properly
// — that path already re-enters `process()` with the remainder (see
// `pasteMode` below) so it naturally re-joins. The raw/unwrapped fallback
// below has no such wrapper to key off, so a large paste comes through as
// multiple independent "plain multiline burst" detections; without
// coalescing them, each fragment collapses into its own "[Pasted N lines]"
// chip instead of one. Debounce window for treating consecutive bursts as
// one paste — comfortably longer than the gap between chunks of a single
// write() hitting the pty, short enough that it's not felt as input lag.
const PLAIN_PASTE_COALESCE_MS = 30;

// Safety timeout for bracketed paste mode: if the terminal sent the
// paste-start marker (\x1b[200~) but the end marker (\x1b[201~) never
// arrives (terminal bug, tmux/screen interference, interrupted paste),
// pasteMode would stay true forever, silently swallowing ALL subsequent
// stdin — Ctrl+C, Esc, Enter, everything. This timeout flushes whatever
// has been accumulated and exits pasteMode so the user isn't stuck.
const BRACKETED_PASTE_TIMEOUT_MS = 5000;

export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	private buffer = "";
	private timeout: ReturnType<typeof setTimeout> | null = null;
	private readonly timeoutMs: number;
	private readonly bracketedPasteTimeoutMs: number;
	private pasteMode = false;
	private pasteBuffer = "";
	private pasteModeTimeout: ReturnType<typeof setTimeout> | null = null;
	private pendingKittyPrintableCodepoint: number | undefined;
	private pendingPlainPaste: string | null = null;
	private plainPasteTimeout: ReturnType<typeof setTimeout> | null = null;

	constructor(options?: { timeout?: number; pasteTimeout?: number }) {
		super();
		this.timeoutMs = options?.timeout ?? 10;
		this.bracketedPasteTimeoutMs = options?.pasteTimeout ?? BRACKETED_PASTE_TIMEOUT_MS;
	}

	public process(data: string | Buffer): void {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		let str: string;
		if (Buffer.isBuffer(data)) {
			if (data.length === 1 && data[0]! > 127) {
				str = `\x1b${String.fromCharCode(data[0]! - 128)}`;
			} else {
				str = data.toString();
			}
		} else {
			str = data;
		}

		if (str.length === 0 && this.buffer.length === 0) {
			this.emitDataSequence("");
			return;
		}
		this.buffer += str;

		if (this.pasteMode) {
			this.pasteBuffer += this.buffer;
			this.buffer = "";
			const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
			if (endIndex !== -1) {
				const pastedContent = this.pasteBuffer.slice(0, endIndex);
				const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);
				this.exitPasteMode();
				this.emit("paste", pastedContent);
				if (remaining.length > 0) this.process(remaining);
			}
			return;
		}

		const startIndex = this.buffer.indexOf(BRACKETED_PASTE_START);
		if (startIndex !== -1) {
			this.flushPlainPaste();
			if (startIndex > 0) {
				const result = extractCompleteSequences(this.buffer.slice(0, startIndex));
				for (const seq of result.sequences) this.emitDataSequence(seq);
			}
			this.pendingKittyPrintableCodepoint = undefined;
			this.buffer = this.buffer.slice(startIndex + BRACKETED_PASTE_START.length);
			this.pasteMode = true;
			this.pasteBuffer = this.buffer;
			this.buffer = "";
			this.pasteModeTimeout = setTimeout(() => this.abortPasteMode(), this.bracketedPasteTimeoutMs);
			const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
			if (endIndex !== -1) {
				const pastedContent = this.pasteBuffer.slice(0, endIndex);
				const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);
				this.exitPasteMode();
				this.emit("paste", pastedContent);
				if (remaining.length > 0) this.process(remaining);
			}
			return;
		}

		const result = extractCompleteSequences(this.buffer);
		this.buffer = result.remainder;

		// Some terminals (older Cursor builds among them — see this file's git
		// history) don't wrap a paste in \x1b[200~..\x1b[201~ at all; clipboard
		// content just lands as plain bytes, indistinguishable from typing
		// except that no human types fast enough to deliver several
		// characters *spanning at least two lines* in one batch. Checking
		// this against the already-parsed sequence list (not the raw chunk)
		// matters: an earlier version checked the raw incoming chunk instead,
		// which misfired when the OS/terminal happened to split a *real*
		// escape sequence (e.g. the bracketed-paste end marker itself) across
		// two reads — the continuation half doesn't start with ESC either, so
		// it looked like a fresh plain-text burst and swallowed the dangling
		// escape fragment as literal text. Requiring an empty `remainder`
		// (nothing left mid-sequence) and every sequence to be a single plain
		// character (a real escape sequence is always >1 char) rules that out.
		const isPlainBurst =
			result.remainder === "" && result.sequences.length > 0 && result.sequences.every((seq) => seq.length === 1);
		// A typed line + Enter arrives in one batch as `text\r` (or `text\n`)
		// — the newline is the *last* character. A genuine multi-line paste has
		// a newline *before* the end (e.g. `line1\nline2`, `a\nb\nc\n`). Only
		// the latter should start a paste accumulation: requiring an "interior"
		// newline lets fast typing + Enter submit normally (the Enter matches
		// the submit binding instead of being swallowed into a fake paste),
		// while still catching real multi-line pastes on terminals that don't
		// emit bracketed-paste markers. A bare Enter ("\r") has no interior
		// newline and is excluded by the same rule.
		const joined = result.sequences.join("");
		const norm = joined.replace(/\r/g, "\n");
		const nlIndex = norm.indexOf("\n");
		const hasInteriorNewline = nlIndex >= 0 && nlIndex < norm.length - 1;
		const startsNewBurst = this.pendingPlainPaste === null && hasInteriorNewline;
		// Once a burst is in progress, any plain chunk continues it: the last
		// line of a real paste often arrives alone, with or without a trailing
		// newline, in its own chunk.
		const continuesBurst = this.pendingPlainPaste !== null;

		if (isPlainBurst && (continuesBurst || startsNewBurst)) {
			this.pendingPlainPaste = (this.pendingPlainPaste ?? "") + result.sequences.join("");
			if (this.plainPasteTimeout) clearTimeout(this.plainPasteTimeout);
			this.plainPasteTimeout = setTimeout(() => this.flushPlainPaste(), PLAIN_PASTE_COALESCE_MS);
			return;
		}

		// A real key/escape sequence arrived — anything accumulated so far is
		// a complete paste on its own; emit it before this batch so ordering
		// in the composer matches what was actually typed/pasted.
		this.flushPlainPaste();
		for (const seq of result.sequences) this.emitDataSequence(seq);

		if (this.buffer.length > 0) {
			// Don't set a flush timeout when the buffer starts with ESC —
			// it could be a partial escape sequence (e.g. \x1b[20 waiting
			// for 0~ to complete the paste-start marker \x1b[200~). Flushing
			// it after 10ms would turn the partial marker into garbage
			// keystrokes. Wait for the next stdin data event instead.
			if (!this.buffer.startsWith(ESC)) {
				this.timeout = setTimeout(() => {
					const flushed = this.flush();
					for (const seq of flushed) this.emitDataSequence(seq);
				}, this.timeoutMs);
			}
		}
	}

	private emitDataSequence(sequence: string): void {
		const rawCodepoint = sequence.length === 1 ? sequence.codePointAt(0) : undefined;
		if (rawCodepoint !== undefined && rawCodepoint === this.pendingKittyPrintableCodepoint) {
			this.pendingKittyPrintableCodepoint = undefined;
			return;
		}
		this.pendingKittyPrintableCodepoint = parseUnmodifiedKittyPrintableCodepoint(sequence);
		this.emit("data", sequence);
	}

	/** Emits whatever's accumulated in the plain-paste coalescing buffer, if anything. */
	private flushPlainPaste(): void {
		if (this.plainPasteTimeout) {
			clearTimeout(this.plainPasteTimeout);
			this.plainPasteTimeout = null;
		}
		if (this.pendingPlainPaste === null) return;
		const text = this.pendingPlainPaste.replace(/\r\n?/g, "\n");
		this.pendingPlainPaste = null;
		this.pendingKittyPrintableCodepoint = undefined;
		this.emit("paste", text);
	}

	/** Cleanly exit pasteMode — clears the safety timeout and resets state. */
	private exitPasteMode(): void {
		if (this.pasteModeTimeout) {
			clearTimeout(this.pasteModeTimeout);
			this.pasteModeTimeout = null;
		}
		this.pasteMode = false;
		this.pasteBuffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
	}

	/**
	 * Bracketed-paste end marker never arrived — emit whatever was
	 * accumulated as a paste so the user isn't stuck with a dead input.
	 */
	private abortPasteMode(): void {
		const content = this.pasteBuffer;
		this.pasteModeTimeout = null;
		this.pasteMode = false;
		this.pasteBuffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
		if (content) this.emit("paste", content);
	}

	flush(): string[] {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}
		if (this.buffer.length === 0) return [];
		const sequences = [this.buffer];
		this.buffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
		return sequences;
	}

	clear(): void {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}
		if (this.plainPasteTimeout) {
			clearTimeout(this.plainPasteTimeout);
			this.plainPasteTimeout = null;
		}
		this.pendingPlainPaste = null;
		this.buffer = "";
		if (this.pasteModeTimeout) {
			clearTimeout(this.pasteModeTimeout);
			this.pasteModeTimeout = null;
		}
		this.pasteMode = false;
		this.pasteBuffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
	}

	destroy(): void {
		this.clear();
	}
}
