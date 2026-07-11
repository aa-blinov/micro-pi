/**
 * Pure text-buffer logic for the Composer — no React, no stdin, no terminal
 * escapes. Exclusively manipulates an internal string + cursor position so
 * it can be unit-tested without rendering anything.
 */
import { findWordBackward, findWordForward } from "./word-nav.ts";

export class TextBuffer {
	private text = "";
	private cursor = 0;

	get value(): string {
		return this.text;
	}

	get cursorPos(): number {
		return this.cursor;
	}

	get length(): number {
		return this.text.length;
	}

	insert(s: string): void {
		this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor);
		this.cursor += s.length;
	}

	insertNewline(): void {
		this.insert("\n");
	}

	// The buffer indexes UTF-16 code units, but the cursor must only ever rest
	// on code-point boundaries: stepping or deleting a single unit inside an
	// astral character (emoji, some CJK extensions) leaves a lone surrogate —
	// mojibake in the render and in the submitted text.

	/** Position one code point left of `pos` (skips over a surrogate pair). */
	private prevBoundary(pos: number): number {
		if (pos <= 0) return 0;
		const low = this.text.charCodeAt(pos - 1);
		if (low >= 0xdc00 && low <= 0xdfff && pos >= 2) {
			const high = this.text.charCodeAt(pos - 2);
			if (high >= 0xd800 && high <= 0xdbff) return pos - 2;
		}
		return pos - 1;
	}

	/** Position one code point right of `pos` (skips over a surrogate pair). */
	private nextBoundary(pos: number): number {
		if (pos >= this.text.length) return this.text.length;
		const high = this.text.charCodeAt(pos);
		if (high >= 0xd800 && high <= 0xdbff && pos + 1 < this.text.length) {
			const low = this.text.charCodeAt(pos + 1);
			if (low >= 0xdc00 && low <= 0xdfff) return pos + 2;
		}
		return pos + 1;
	}

	/** If `pos` sits between the halves of a surrogate pair, snap to its start. */
	private snapBoundary(pos: number): number {
		if (pos <= 0 || pos >= this.text.length) return pos;
		const code = this.text.charCodeAt(pos);
		if (code >= 0xdc00 && code <= 0xdfff) {
			const high = this.text.charCodeAt(pos - 1);
			if (high >= 0xd800 && high <= 0xdbff) return pos - 1;
		}
		return pos;
	}

	backspace(): void {
		if (this.cursor === 0) return;
		const target = this.prevBoundary(this.cursor);
		this.text = this.text.slice(0, target) + this.text.slice(this.cursor);
		this.cursor = target;
	}

	deleteForward(): void {
		if (this.cursor >= this.text.length) return;
		this.text = this.text.slice(0, this.cursor) + this.text.slice(this.nextBoundary(this.cursor));
	}

	moveLeft(): void {
		this.cursor = this.prevBoundary(this.cursor);
	}

	moveRight(): void {
		this.cursor = this.nextBoundary(this.cursor);
	}

	moveUp(): void {
		const currentLineStart = this.text.lastIndexOf("\n", this.cursor - 1) + 1;
		const col = this.cursor - currentLineStart;
		const prevNewline = this.text.lastIndexOf("\n", currentLineStart - 2);
		const prevLineStart = prevNewline === -1 ? 0 : prevNewline + 1;
		const prevLineEnd = this.text.indexOf("\n", prevLineStart);
		const prevLineLength = (prevLineEnd === -1 ? this.text.length : prevLineEnd) - prevLineStart;
		this.cursor = this.snapBoundary(prevLineStart + Math.min(col, prevLineLength));
	}

	moveDown(): void {
		const currentLineStart = this.text.lastIndexOf("\n", this.cursor - 1) + 1;
		const col = this.cursor - currentLineStart;
		const nextNewline = this.text.indexOf("\n", this.cursor);
		if (nextNewline === -1) {
			this.cursor = this.text.length;
			return;
		}
		const nextLineStart = nextNewline + 1;
		const nextLineEnd = this.text.indexOf("\n", nextLineStart);
		const nextLineLength = (nextLineEnd === -1 ? this.text.length : nextLineEnd) - nextLineStart;
		this.cursor = this.snapBoundary(nextLineStart + Math.min(col, nextLineLength));
	}

	moveLineStart(): void {
		const nl = this.text.lastIndexOf("\n", this.cursor - 1);
		this.cursor = nl === -1 ? 0 : nl + 1;
	}

	moveLineEnd(): void {
		const nl = this.text.indexOf("\n", this.cursor);
		this.cursor = nl === -1 ? this.text.length : nl;
	}

	moveWordLeft(): void {
		this.cursor = findWordBackward(this.text, this.cursor);
	}

	moveWordRight(): void {
		this.cursor = findWordForward(this.text, this.cursor);
	}

	deleteWordBackward(): void {
		if (this.cursor === 0) return;
		const target = findWordBackward(this.text, this.cursor);
		this.text = this.text.slice(0, target) + this.text.slice(this.cursor);
		this.cursor = target;
	}

	deleteWordForward(): void {
		if (this.cursor >= this.text.length) return;
		const target = findWordForward(this.text, this.cursor);
		this.text = this.text.slice(0, this.cursor) + this.text.slice(target);
	}

	deleteToLineStart(): void {
		const lineStart = this.text.lastIndexOf("\n", this.cursor - 1) + 1;
		if (this.cursor === lineStart) return;
		this.text = this.text.slice(0, lineStart) + this.text.slice(this.cursor);
		this.cursor = lineStart;
	}

	deleteToLineEnd(): void {
		const lineEnd = this.text.indexOf("\n", this.cursor);
		if (lineEnd === -1) {
			this.text = this.text.slice(0, this.cursor);
		} else {
			this.text = this.text.slice(0, this.cursor) + this.text.slice(lineEnd);
		}
	}

	clear(): void {
		this.text = "";
		this.cursor = 0;
	}

	setText(text: string): void {
		this.text = text;
		this.cursor = Math.min(this.cursor, text.length);
	}

	getLines(): string[] {
		return this.text.split("\n");
	}

	getCursorLine(): number {
		return this.text.slice(0, this.cursor).split("\n").length - 1;
	}

	getCursorColumn(): number {
		return this.text.slice(0, this.cursor).split("\n").pop()!.length;
	}

	/** Compute lines, cursor line, and cursor column in a single pass. */
	getLayout(): { lines: string[]; cursorLine: number; cursorCol: number } {
		const lines = this.text.split("\n");
		let cursorLine = 0;
		let cursorCol = this.cursor;
		for (let i = 0; i < lines.length; i++) {
			const lineLen = lines[i]!.length;
			if (cursorCol <= lineLen) {
				cursorLine = i;
				break;
			}
			cursorCol -= lineLen + 1; // +1 for the newline
			if (i === lines.length - 1) {
				cursorLine = i;
			}
		}
		return { lines, cursorLine, cursorCol };
	}
}
