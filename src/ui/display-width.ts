/**
 * Display-width cache for terminal column measurement.
 *
 * CJK and emoji code points occupy two cells; counting UTF-16 units
 * undercounts wrapped rows, which lets the live region overrun the viewport.
 * displayWidth() computes the real width; identical strings always produce
 * the same result, so the cache is safe.
 *
 * During streaming the same prefix lines are measured every ~16 ms frame.
 * The cache is flushed when streaming ends to free memory.
 */

const cache = new Map<string, number>();

export function displayWidth(line: string): number {
	const cached = cache.get(line);
	if (cached !== undefined) return cached;
	let w = 0;
	for (const ch of line) {
		const cp = ch.codePointAt(0) ?? 0;
		const wide =
			(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
			(cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
			(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
			(cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
			(cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
			(cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
			(cp >= 0xffe0 && cp <= 0xffe6) ||
			cp >= 0x1f300; // emoji & symbols (approximation)
		w += wide ? 2 : 1;
	}
	cache.set(line, w);
	return w;
}

/** Flush the cache. Call when streaming ends to free memory. */
export function displayWidthCacheFlush(): void {
	cache.clear();
}
