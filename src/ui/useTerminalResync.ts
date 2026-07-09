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
 *    corrupting the display.
 *
 *    Detection strategy (two layers):
 *
 *    a. Height heuristic (fast, no I/O): when a frame's CUU distance exceeds
 *       the terminal height, the live area is taller than the viewport — a
 *       strong signal it has scrolled. Recomputed every frame (non-sticky).
 *
 *    b. DECXCPR polling (periodic, handles short frames): send `\x1b[6n]`
 *       to query the real cursor row. After Ink draws, the cursor sits at
 *       the bottom of the viewport (row == terminal height). If the user
 *       scrolled up, the cursor drops below the visible area and DECXCPR
 *       reports row > height. stdin is paused during the query so Ink can't
 *       consume the response. A 500 ms interval keeps the flag fresh.
 *
 *    Either signal triggers the guard: cursor/erase writes are swallowed
 *    until the user scrolls back to the bottom.
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

		// --- scroll guard state (shared by both detection layers) ---
		let scrollUp = false;

		// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI parsing
		const CUU_RE = /\x1b\[(\d*)A/;
		// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI detection
		const CURSOR_OR_ERASE_RE = /\x1b\[(?:\d+)*[A-HJKSTf]/;

		// --- layer (a): height heuristic per frame ---
		out.write = function scrollGuardWrite(
			chunk: string | Uint8Array,
			...args: [BufferEncoding?, ((err?: Error | null) => void)?]
		): boolean {
			const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);

			// log-update starts each frame with `\x1b[<n>A` (move up past the
			// previous frame). n > terminal rows means the live area doesn't fit
			// on screen. Recompute both directions so the guard can never latch.
			const m = CUU_RE.exec(s);
			if (m) {
				const cuuScrolled = (Number(m[1]) || 1) > (out.rows || 24);
				if (cuuScrolled) scrollUp = true;
				// Only clear the flag via CUU when DECXCPR is not active —
				// DECXCPR is authoritative when the interval is running.
				else if (!decxprActive) scrollUp = false;
			}

			if (scrollUp && CURSOR_OR_ERASE_RE.test(s)) {
				return true; // swallow — don't erase/redraw while scrolled
			}
			return origWrite(chunk, ...args);
		} as typeof out.write;

		// --- layer (b): DECXCPR cursor-position polling ---
		// biome-ignore lint/suspicious/noControlCharactersInRegex: DECXCPR response format
		const DECXCPR_RE = /\x1b\[(\d+);(\d+)R/;
		const QUERY = "\x1b[6n";
		const POLL_MS = 500;
		const TIMEOUT_MS = 600;

		let decxprActive = false;
		let queryTimeout: ReturnType<typeof setTimeout> | null = null;

		function startQuery() {
			if (!process.stdin.isTTY) return;
			// Pause stdin so Ink can't consume the DECXCPR response.
			process.stdin.pause();
			decxprActive = true;

			let buf = "";
			let active = true;

			function cleanup(scrolled: boolean) {
				if (!active) return;
				active = false;
				process.stdin.off("data", onStdin);
				process.stdin.resume();
				scrollUp = scrolled;
			}

			function onStdin(chunk: Buffer) {
				if (!active) return;
				buf += chunk.toString();
				const match = DECXCPR_RE.exec(buf);
				if (match) {
					const row = Number(match[1]);
					const rows = out.rows || 24;
					cleanup(row > rows);
				}
			}

			process.stdin.on("data", onStdin);
			origWrite(QUERY);

			queryTimeout = setTimeout(() => {
				// Terminal didn't respond — assume no scroll.
				cleanup(false);
			}, TIMEOUT_MS);
		}

		const pollInterval = setInterval(startQuery, POLL_MS);

		const restore = () => {
			out.write = origWrite;
		};
		process.on("exit", restore);

		return () => {
			out.off("resize", onResize);
			if (resizeTimer) clearTimeout(resizeTimer);
			clearInterval(pollInterval);
			if (queryTimeout) clearTimeout(queryTimeout);
			restore();
			process.off("exit", restore);
		};
	}, [onResync]);
}
