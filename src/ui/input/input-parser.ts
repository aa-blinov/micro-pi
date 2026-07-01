/**
 * Input event parser — uses StdinBuffer for proper buffering and keys.ts
 * for key identification. Maps raw terminal input to semantic events that
 * the Composer can act on.
 *
 * Paste handling lives in the Composer's stdinDataHandler (before InputParser),
 * so this module only deals with keypresses and escape sequences.
 */

import { getKeybindings, type Keybinding } from "./keybindings.ts";
import { decodePrintableKey, setKittyProtocolActive } from "./keys.ts";
import { StdinBuffer } from "./stdin-buffer.ts";

export type InputEvent = { type: "binding"; binding: Keybinding; raw: string } | { type: "char"; text: string };

const BINDING_ORDER: Keybinding[] = [
	"input.submit",
	"input.newLine",
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
	private buffer: StdinBuffer;
	private emit: (event: InputEvent) => void;
	private keybindings = getKeybindings();

	constructor(onEvent: (event: InputEvent) => void) {
		this.emit = onEvent;
		this.buffer = new StdinBuffer();

		this.buffer.on("data", (sequence: string) => {
			this.handleSequence(sequence);
		});
	}

	private handleSequence(sequence: string): void {
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
		this.buffer.destroy();
	}
}
