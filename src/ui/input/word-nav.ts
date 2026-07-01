/**
 * Word navigation helpers — ported from pi's packages/tui/src/word-navigation.ts.
 *
 * Uses Intl.Segmenter (granularity: "word") for locale-aware word boundary
 * detection. ASCII punctuation is handled as atomic segments.
 */

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

const PUNCTUATION_REGEX = /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/;

function isWhitespaceChar(char: string): boolean {
	return /^\s$/.test(char);
}

/**
 * Find cursor position after moving one word backward from `cursor`.
 * Skips trailing whitespace, then stops at the next word/punctuation boundary.
 */
export function findWordBackward(text: string, cursor: number): number {
	if (cursor <= 0) return 0;

	const textBeforeCursor = text.slice(0, cursor);
	const segments = [...wordSegmenter.segment(textBeforeCursor)];
	let newCursor = cursor;

	while (segments.length > 0 && isWhitespaceChar(segments[segments.length - 1]?.segment || "")) {
		newCursor -= segments.pop()?.segment.length || 0;
	}

	if (segments.length === 0) return newCursor;

	const last = segments[segments.length - 1]!;

	if (last.isWordLike) {
		const segment = last.segment;
		const matches = [...segment.matchAll(new RegExp(PUNCTUATION_REGEX, "g"))];
		if (matches.length <= 0) {
			newCursor -= segment.length;
		} else {
			const lastMatch = matches[matches.length - 1]!;
			newCursor -= segment.length - (lastMatch.index + lastMatch[0].length);
		}
	} else {
		while (
			segments.length > 0 &&
			!segments[segments.length - 1]?.isWordLike &&
			!isWhitespaceChar(segments[segments.length - 1]?.segment || "")
		) {
			newCursor -= segments.pop()?.segment.length || 0;
		}
	}

	return newCursor;
}

/**
 * Find cursor position after moving one word forward from `cursor`.
 * Skips leading whitespace, then stops at the next word/punctuation boundary.
 */
export function findWordForward(text: string, cursor: number): number {
	if (cursor >= text.length) return text.length;

	const textAfterCursor = text.slice(cursor);
	const segments = wordSegmenter.segment(textAfterCursor);
	const iterator = segments[Symbol.iterator]();
	let next = iterator.next();
	let newCursor = cursor;

	while (!next.done && isWhitespaceChar(next.value.segment)) {
		newCursor += next.value.segment.length;
		next = iterator.next();
	}

	if (next.done) return newCursor;

	if (next.value.isWordLike) {
		newCursor += PUNCTUATION_REGEX.exec(next.value.segment)?.index ?? next.value.segment.length;
	} else {
		while (!next.done && !next.value.isWordLike && !isWhitespaceChar(next.value.segment)) {
			newCursor += next.value.segment.length;
			next = iterator.next();
		}
	}

	return newCursor;
}
