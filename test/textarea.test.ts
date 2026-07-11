import { describe, expect, it } from "vitest";
import { TextBuffer } from "../src/ui/input/textarea.ts";

describe("TextBuffer", () => {
	it("inserts text at the cursor", () => {
		const buf = new TextBuffer();
		buf.insert("hello");
		expect(buf.value).toBe("hello");
		expect(buf.cursorPos).toBe(5);
	});

	it("inserts in the middle", () => {
		const buf = new TextBuffer();
		buf.insert("helo");
		buf.moveLeft();
		buf.moveLeft();
		buf.insert("l");
		expect(buf.value).toBe("hello");
		expect(buf.cursorPos).toBe(3);
	});

	it("backspace deletes before the cursor", () => {
		const buf = new TextBuffer();
		buf.insert("hello");
		buf.backspace();
		expect(buf.value).toBe("hell");
		expect(buf.cursorPos).toBe(4);
	});

	it("backspace at position 0 is a no-op", () => {
		const buf = new TextBuffer();
		buf.backspace();
		expect(buf.value).toBe("");
		expect(buf.cursorPos).toBe(0);
	});

	it("deleteForward deletes after the cursor", () => {
		const buf = new TextBuffer();
		buf.insert("hello");
		buf.moveLeft();
		buf.moveLeft();
		buf.deleteForward();
		expect(buf.value).toBe("helo");
		expect(buf.cursorPos).toBe(3);
	});

	it("insertNewline and cursor movement across lines", () => {
		const buf = new TextBuffer();
		buf.insert("ab");
		buf.insertNewline();
		buf.insert("cd");
		expect(buf.value).toBe("ab\ncd");
		expect(buf.getCursorLine()).toBe(1);
		expect(buf.getCursorColumn()).toBe(2);
		buf.moveUp();
		expect(buf.getCursorLine()).toBe(0);
		expect(buf.getCursorColumn()).toBe(2);
		buf.moveLineEnd();
		expect(buf.getCursorColumn()).toBe(2);
	});

	it("moveUp at the first line is a no-op (can't go above line 0)", () => {
		const buf = new TextBuffer();
		buf.insert("abc");
		buf.moveUp();
		expect(buf.cursorPos).toBe(3);
	});

	it("moveDown past the last line goes to the end", () => {
		const buf = new TextBuffer();
		buf.insert("abc");
		buf.moveLeft();
		buf.moveDown();
		expect(buf.cursorPos).toBe(3);
	});

	it("clear resets text and cursor", () => {
		const buf = new TextBuffer();
		buf.insert("hello");
		buf.clear();
		expect(buf.value).toBe("");
		expect(buf.cursorPos).toBe(0);
		expect(buf.length).toBe(0);
	});

	it("bracketed paste payload inserts verbatim with newlines", () => {
		const buf = new TextBuffer();
		buf.insert("line1\nline2\nline3");
		expect(buf.getLines()).toEqual(["line1", "line2", "line3"]);
	});

	describe("surrogate pairs (emoji)", () => {
		it("backspace removes a whole astral character, not half a pair", () => {
			const buf = new TextBuffer();
			buf.insert("a😀"); // 😀 = U+1F600, two UTF-16 units
			buf.backspace();
			expect(buf.value).toBe("a");
			expect(buf.cursorPos).toBe(1);
		});

		it("deleteForward removes a whole astral character", () => {
			const buf = new TextBuffer();
			buf.insert("😀b");
			buf.moveLineStart();
			buf.deleteForward();
			expect(buf.value).toBe("b");
			expect(buf.cursorPos).toBe(0);
		});

		it("moveLeft/moveRight step over a pair as one character", () => {
			const buf = new TextBuffer();
			buf.insert("a😀b");
			buf.moveLeft(); // before b
			expect(buf.cursorPos).toBe(3);
			buf.moveLeft(); // before 😀 (skips both units)
			expect(buf.cursorPos).toBe(1);
			buf.moveRight(); // after 😀
			expect(buf.cursorPos).toBe(3);
		});

		it("moveDown snaps a column landing inside a pair to its start", () => {
			const buf = new TextBuffer();
			buf.insert("aaaa\n😀b");
			// Cursor to line 0, column 1: moveUp keeps column 3, two moveLefts
			// land on column 1.
			buf.moveUp();
			buf.moveLeft();
			buf.moveLeft();
			expect(buf.cursorPos).toBe(1);
			buf.moveDown();
			// Column 1 of "😀b" is the middle of the surrogate pair — snapped
			// back to the pair's start (column 0, absolute position 5).
			expect(buf.cursorPos).toBe(5);
		});
	});
});
