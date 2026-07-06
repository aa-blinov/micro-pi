import { describe, expect, it } from "vitest";
import {
	CHIP_CHAR_START,
	chipCharFor,
	expandPastes,
	isChipChar,
	type PendingPaste,
	pasteLabel,
} from "../src/ui/paste.ts";

describe("paste.ts", () => {
	it("chipCharFor yields distinct single UTF-16 code units from the PUA", () => {
		const a = chipCharFor(0);
		const b = chipCharFor(1);
		expect(a).not.toBe(b);
		expect(a.length).toBe(1);
		expect(b.length).toBe(1);
		expect(a.codePointAt(0)).toBe(CHIP_CHAR_START);
		expect(b.codePointAt(0)).toBe(CHIP_CHAR_START + 1);
		expect(isChipChar(a)).toBe(true);
		expect(isChipChar(b)).toBe(true);
	});

	it("isChipChar rejects typed text and empty input", () => {
		expect(isChipChar("a")).toBe(false);
		expect(isChipChar("\n")).toBe(false);
		expect(isChipChar("/")).toBe(false);
		expect(isChipChar("")).toBe(false);
		expect(isChipChar(undefined)).toBe(false);
	});

	it("pasteLabel formats lines and chars branches", () => {
		expect(pasteLabel(12, 200)).toBe("[Pasted 12 lines]");
		expect(pasteLabel(5, 1234)).toBe("[Pasted 1234 chars]");
	});

	it("expandPastes swaps each chip back to its text", () => {
		const c1 = chipCharFor(0);
		const c2 = chipCharFor(1);
		const pastes: PendingPaste[] = [
			{ char: c1, label: pasteLabel(12, 200), text: "block-A-line1\nblock-A-line2" },
			{ char: c2, label: pasteLabel(2, 40), text: "block-B-line1\nblock-B-line2" },
		];
		const buffer = `before ${c1} between ${c2} after`;
		expect(expandPastes(buffer, pastes)).toBe(
			"before block-A-line1\nblock-A-line2 between block-B-line1\nblock-B-line2 after",
		);
	});

	it("expandPastes handles two chips with the same label (distinct chars)", () => {
		const c1 = chipCharFor(0);
		const c2 = chipCharFor(1);
		const pastes: PendingPaste[] = [
			{ char: c1, label: "[Pasted 12 lines]", text: "AAA" },
			{ char: c2, label: "[Pasted 12 lines]", text: "BBB" },
		];
		expect(expandPastes(`${c1} X ${c2}`, pastes)).toBe("AAA X BBB");
	});

	it("expandPastes leaves the buffer intact when a chip was deleted", () => {
		const c1 = chipCharFor(0);
		const c2 = chipCharFor(1);
		// Chip 1 was backspaced away (char no longer in buffer) but its entry
		// still lingers in pendingPastes — replace finds no occurrence, no-op.
		const pastes: PendingPaste[] = [
			{ char: c1, label: "[Pasted 12 lines]", text: "AAA" },
			{ char: c2, label: "[Pasted 12 lines]", text: "BBB" },
		];
		expect(expandPastes(`only ${c2} here`, pastes)).toBe("only BBB here");
	});

	it("chip characters are atomic in a TextBuffer-like insert/backspace/move", () => {
		// Simulate the operations Composer drives on TextBuffer with a chip in
		// the middle and typed text around it — the chip is one char, so a
		// single backspace removes the whole chip, not a fragment of it.
		const c = chipCharFor(0);
		let text = `ab${c}cd`;
		let cursor = text.length; // after "cd"
		// move left twice -> between chip and "cd"
		cursor -= 2;
		expect(text.slice(cursor, cursor + 1)).toBe("c");
		// backspace removes the chip whole (one char before cursor is the chip)
		cursor -= 1;
		text = text.slice(0, cursor) + text.slice(cursor + 1);
		expect(text).toBe("abcd");
		expect(isChipChar(text[2])).toBe(false);
	});
});
