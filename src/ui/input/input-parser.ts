/**
 * Input event parser — uses StdinBuffer for proper buffering and keys.ts
 * for key identification. Maps raw terminal input to semantic events that
 * the Composer can act on.
 *
 * Paste handling lives in the shared StdinBuffer ("paste" events); this
 * module only deals with keypresses and escape sequences ("data" events).
 */

import { getKeybindings, type Keybinding } from "./keybindings.ts";
import { decodePrintableKey, setKittyProtocolActive } from "./keys.ts";
import { StdinBuffer } from "./stdin-buffer.ts";

export type InputEvent = { type: "binding"; binding: Keybinding; raw: string } | { type: "char"; text: string };

const BINDING_ORDER: Keybinding[] = [
	// newLine before submit: the "enter" matcher also claims a raw \n on
	// non-Kitty terminals, but there \n is Ctrl+J — the documented newline
	// fallback for terminals where Shift+Enter is indistinguishable from
	// Enter. With submit first, Ctrl+J submitted the message instead. The
	// reverse ordering is safe: none of newLine's keys (shift+enter, ctrl+j,
	// alt+enter) ever match a plain \r / kp-Enter / unmodified CSI-u Enter,
	// so submit still wins for every actual Enter press.
	"input.newLine",
	"input.submit",
	"input.abort",
	"input.escape",
	"input.attachImage",
	"editor.deleteWordBackward",
	"editor.deleteWordForward",
	"editor.deleteToLineStart",
	"editor.deleteToLineEnd",
	"editor.cursorWordLeft",
	"editor.cursorWordRight",
	"editor.cursorLineStart",
	"editor.cursorLineEnd",
	"editor.deleteCharForward",
	"editor.deleteCharBackward",
	"editor.cursorUp",
	"editor.cursorDown",
	"editor.cursorLeft",
	"editor.cursorRight",
	"input.tab",
];

/**
 * Wraps StdinBuffer + keys.ts: receives raw stdin chunks, buffers incomplete
 * sequences, identifies completed sequences as semantic InputEvents.
 */
export class InputParser {
	private externalBuffer: StdinBuffer | undefined;
	private buffer: StdinBuffer;
	private emit: (event: InputEvent) => void;
	private keybindings = getKeybindings();

	constructor(onEvent: (event: InputEvent) => void, buffer?: StdinBuffer) {
		this.emit = onEvent;
		this.externalBuffer = buffer;
		this.buffer = buffer ?? new StdinBuffer();

		this.buffer.on("data", (sequence: string) => {
			this.handleSequence(sequence);
		});
	}

	private handleSequence(sequence: string): void {
		// Focus in/out reports (CSI I / CSI O), emitted because useTerminalResync
		// enables focus reporting (\x1b[?1004h) to redraw after alt-tab. They are
		// terminal control chatter, not input — drop them so they never surface as
		// a stray char in the composer. (They would fall through to "ignore" below
		// anyway; matched explicitly so the intent is clear and can't regress.)
		if (sequence === "\x1b[I" || sequence === "\x1b[O") {
			return;
		}

		// DECXCPR cursor-position response (\x1b[row;colR), emitted by the
		// terminal in reply to useTerminalResync's periodic \x1b[6n query. The
		// poll's own stdin listener processes it independently, but the same
		// chunk reaches the Composer's StdinBuffer too. StdinBuffer correctly
		// parses it as a complete CSI sequence (R is in 0x40..0x7e); this
		// explicit drop makes the intent clear and prevents a future keybinding
		// from accidentally matching it.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: DECXCPR response
		if (/^\x1b\[\d+;\d+R$/.test(sequence)) {
			return;
		}

		// Check for Kitty protocol activation hints
		if (sequence.includes(":3u") || sequence.includes(":3~")) {
			setKittyProtocolActive(true);
		}

		for (const binding of BINDING_ORDER) {
			if (this.keybindings.matches(sequence, binding)) {
				this.emit({ type: "binding", binding, raw: sequence });
				return;
			}
		}

		// Printable character (Kitty CSI-u, modifyOtherKeys, or raw)
		const printable = decodePrintableKey(sequence);
		if (printable) {
			this.emit({ type: "char", text: printable });
			return;
		}

		// Single printable byte (not caught by any binding or CSI-u)
		// Accept any char >= 32, including Cyrillic (0x0400-0x04FF) and other
		// non-ASCII printable characters that arrive as single code units.
		if (sequence.length === 1) {
			const code = sequence.charCodeAt(0);
			if (code >= 32) {
				this.emit({ type: "char", text: sequence });
				return;
			}
		}

		// Unrecognized — ignore
	}

	feed(chunk: Buffer): void {
		this.buffer.process(chunk);
	}

	destroy(): void {
		if (!this.externalBuffer) this.buffer.destroy();
	}
}
