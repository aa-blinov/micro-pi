import { useEffect } from "react";

/**
 * Two distinct terminal desyncs, one shared remedy (clear + full <Static>
 * replay via the onResync callback):
 *
 * 1. Resize/reflow (VS Code, iTerm) re-wraps on-screen lines — Ink only
 *    self-corrects on width *decrease*; width increases and height changes
 *    leave stale copies of the live region stacked on screen. Debounced so a
 *    drag-resize burst triggers one reset once it settles.
 *
 * 2. Terminal scroll. Ink's log-update writes a full frame per redraw
 *    starting with CUU (`\x1b[<n>A`), assuming the cursor sits exactly where
 *    the previous frame left it. When the viewport is scrolled up that
 *    assumption is wrong and the erase/redraw lands on the wrong rows,
 *    corrupting the display. We can't know the real scrollback offset
 *    without cursor-position queries (DECXCPR), which interfere with Ink's
 *    stdin handling — and we can't capture the wheel to track it ourselves
 *    without disabling the terminal's *native* scrollback, which this app
 *    depends on (history lives in the main screen buffer via <Static>, not a
 *    virtual buffer we render). So we use a non-destructive heuristic:
 *    when a frame's CUU distance exceeds the terminal height, the live area
 *    is taller than the viewport — a strong signal it has scrolled — and we
 *    swallow that frame's cursor/erase writes so they can't corrupt rows.
 *    Recomputed every frame (not latched): once the frame fits again the
 *    guard releases on its own. Plain text/newlines from <Static> always
 *    pass through.
 *
 * Trade-off (unchanged from the original guard): a short response that fits
 * on screen never trips the height heuristic, so scrolling during a short
 * turn can still corrupt — a full fix needs an alternate-screen renderer
 * with its own scrollback, which would replace the <Static> model entirely.
 */
export function useTerminalResync(onResync: () => void): void {
	useEffect(() => {
		const out = process.stdout;
		if (!out.isTTY) return;

		const origWrite = out.write.bind(out);

		// --- resize: debounce a settle, then hard reset ---
		let resizeTimer: ReturnType<typeof setTimeout> | null = null;
		const onResize = () => {
			if (resizeTimer) clearTimeout(resizeTimer);
			resizeTimer = setTimeout(() => {
				// clearTerminal (\x1b[2J\x1b[3J\x1b[H): erase screen + scrollback +
				// home. Scrollback too, so the forced replay below can't leave a
				// duplicate copy of history behind — matches ansiEscapes.clearTerminal,
				// the same sequence Ink writes on its own full-clear path.
				origWrite("\x1b[2J\x1b[3J\x1b[H");
				onResync();
			}, 80);
		};
		out.on("resize", onResize);

		// --- scroll guard: swallow cursor/erase writes while the live frame
		//     is taller than the viewport (recomputed per frame, non-sticky) ---
		let isScrolledUp = false;
		// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI parsing
		const CUU_RE = /\x1b\[(\d*)A/;
		// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI detection
		const CURSOR_OR_ERASE_RE = /\x1b\[(?:\d+)*[A-HJKSTf]/;

		out.write = function scrollGuardWrite(
			chunk: string | Uint8Array,
			...args: [BufferEncoding?, ((err?: Error | null) => void)?]
		): boolean {
			const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);

			// log-update starts each frame with `\x1b[<n>A` (move up past the
			// previous frame). n > terminal rows means the live area doesn't fit
			// on screen. Recompute both directions so the guard can never latch.
			const m = CUU_RE.exec(s);
			if (m) isScrolledUp = (Number(m[1]) || 1) > (out.rows || 24);

			if (isScrolledUp && CURSOR_OR_ERASE_RE.test(s)) {
				return true; // swallow — don't erase/redraw while scrolled
			}
			return origWrite(chunk, ...args);
		} as typeof out.write;

		const restore = () => {
			out.write = origWrite;
		};
		process.on("exit", restore);

		return () => {
			out.off("resize", onResize);
			if (resizeTimer) clearTimeout(resizeTimer);
			restore();
			process.off("exit", restore);
		};
	}, [onResync]);
}
