/**
 * Paste-chip logic for the Composer, extracted so it can be unit-tested
 * without rendering anything.
 *
 * Multi-line pastes are collapsed to a single placeholder character in the
 * TextBuffer — a "chip" — so the composer stays one row tall and the cursor
 * math (which counts buffer characters) never has to reason about the chip's
 * visible width. Each chip is one UTF-16 code unit from the BMP Private Use
 * Area (U+E000..), which no keyboard layout produces, so it can never collide
 * with typed text. On submit, each chip character is swapped back for the real
 * pasted text.
 *
 * Because a chip is exactly one buffer character, every TextBuffer operation
 * (backspace, deleteForward, moveLeft, moveRight, word-nav, line-nav) treats
 * the whole chip as a single atomic unit — there's no way to land the cursor
 * "inside" a chip and corrupt its placeholder, which was the failure mode when
 * chips were stored as the literal multi-char string `[Pasted N lines]`.
 */

export interface PendingPaste {
	/** The single PUA character currently sitting in the TextBuffer. */
	char: string;
	/** Human-readable label shown in the chip, e.g. `[Pasted 12 lines]`. */
	label: string;
	/** The real pasted text the chip expands to on submit. */
	text: string;
}

// Start of the BMP Private Use Area. Each paste in a session gets a unique
// codepoint from here upward; the counter resets on submit / clear, so this
// only needs to cover pastes within a single composer turn (6400 slots).
export const CHIP_CHAR_START = 0xe000;

/** The chip character for the paste at `index` (0-based, resets per turn). */
export function chipCharFor(index: number): string {
	return String.fromCodePoint(CHIP_CHAR_START + index);
}

/** True for a character allocated by `chipCharFor` (i.e. any PUA codepoint). */
export function isChipChar(ch: string | undefined): ch is string {
	if (ch === undefined || ch === "") return false;
	const code = ch.codePointAt(0);
	if (code === undefined) return false;
	return code >= CHIP_CHAR_START && code <= 0xf8ff;
}

export function pasteLabel(lineCount: number, totalChars: number): string {
	return lineCount > 10 ? `[Pasted ${lineCount} lines]` : `[Pasted ${totalChars} chars]`;
}

/**
 * Swap every chip character back to its real pasted text. Each chip has a
 * unique character, so a plain first-occurrence string replace per entry is
 * exact — it hits exactly that one chip and nothing else. Sequential (not
 * global) replacement keeps two chips that happen to share a label distinct,
 * because they still have distinct characters.
 */
export function expandPastes(value: string, pastes: readonly PendingPaste[]): string {
	let out = value;
	for (const p of pastes) {
		out = out.replace(p.char, p.text);
	}
	return out;
}
