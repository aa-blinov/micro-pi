import { useEffect } from "react";
import { isStreamingActive, isTerminalSuspended } from "../core/stdin-manager.ts";

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
 *       reports row > height. The response also reaches the other stdin
 *       consumers (Ink's own parser maps a CSI-R final to a bare f3 key,
 *       the composer's parser drops unmatched CSI sequences), so it needs
 *       no exclusive claim on stdin — pausing the stream wouldn't work
 *       anyway while Ink holds a 'readable' listener, which makes
 *       stdin.pause() a documented no-op. A 500 ms interval keeps the
 *       flag fresh.
 *
 *    Either signal triggers the guard: cursor/erase writes are swallowed
 *    until the user scrolls back to the bottom.
 *
 * The resync itself (clear + \x1b[3J scrollback wipe + replay) is deferred
 * while streaming is active (isStreamingActive, set by useAgentSession),
 * while a child process owns the terminal (suspendAndRun), or while the
 * user is scrolled up — clearing at any of those moments would erase what
 * they're looking at. It fires once conditions clear. No-op resize events
 * (SIGWINCH without an actual size change, e.g. tmux pane focus) are
 * ignored entirely.
 */
export function useTerminalResync(onResync: () => void): void {
	useEffect(() => {
		const out = process.stdout;
		if (!out.isTTY) return;

		const origWrite = out.write.bind(out);

		// --- scroll guard state (shared by both detection layers) ---
		let scrollUp = false;
		// scrollUp is refreshed only by the DECXCPR poll, and the poll is
		// disabled during streaming and terminal suspension — so right after
		// either ends the flag is stale. A resync must not trust a stale
		// "not scrolled": the user may have scrolled up with the trackpad
		// mid-generation, and clearing (+ \x1b[3J scrollback wipe) in the
		// ~200-700ms window before the first fresh poll would yank them to
		// the top of the replayed history. Set stale while streaming/suspended;
		// cleared by every completed poll (which only runs outside both).
		let scrollUpStale = false;

		// --- resize: debounce a settle, then hard reset ---
		let resizeTimer: ReturnType<typeof setTimeout> | null = null;
		let resyncPending = false;
		// Last known size, to drop no-op SIGWINCH events (tmux pane focus,
		// VS Code panel toggles) that fire "resize" without changing anything —
		// each one used to cost a full clear (+ scrollback wipe via \x1b[3J),
		// resetting the user's scroll position for no reason.
		let lastCols = out.columns;
		let lastRows = out.rows;

		// Whether the scroll flag can be trusted right now. Non-TTY stdin never
		// polls, so staleness can't clear there — don't let it block forever.
		const scrollKnown = () => !scrollUpStale || !process.stdin.isTTY;

		const doResync = () => {
			// The clear below includes \x1b[3J (wipe scrollback) — running it
			// while the user is scrolled up reading history yanks them to the
			// bottom and destroys what they were reading. Defer until they
			// return to the bottom (scrollUp is refreshed by the DECXCPR poll),
			// and until the poll has actually run since streaming/suspension
			// ended — a stale "not scrolled" is not a green light.
			if (isStreamingActive() || isTerminalSuspended() || scrollUp || !scrollKnown()) {
				resyncPending = true;
				return;
			}
			resyncPending = false;
			origWrite("\x1b[2J\x1b[3J\x1b[H");
			onResync();
		};

		const onResize = () => {
			// Ignore spurious resize events where the size didn't actually change.
			if (out.columns === lastCols && out.rows === lastRows) return;
			lastCols = out.columns;
			lastRows = out.rows;
			if (resizeTimer) clearTimeout(resizeTimer);
			resizeTimer = setTimeout(doResync, 80);
		};
		out.on("resize", onResize);

		// Flush a deferred resync once streaming ends / terminal is released /
		// the user scrolls back to the bottom — but only after a fresh poll has
		// confirmed the scroll state (see scrollUpStale above).
		const checkDeferredResync = () => {
			if (isStreamingActive() || isTerminalSuspended()) {
				scrollUpStale = true;
				return;
			}
			if (resyncPending && !scrollUp && scrollKnown()) {
				if (resizeTimer) clearTimeout(resizeTimer);
				resizeTimer = setTimeout(doResync, 80);
				resyncPending = false;
			}
		};
		const rawModeCheck = setInterval(checkDeferredResync, 200);

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
				// During streaming the live area routinely exceeds terminal height —
				// Ink handles that by letting the terminal scroll naturally. Only
				// DECXCPR (layer b) can reliably detect *user*-initiated scroll,
				// so never latch scrollUp from the CUU heuristic alone.
				const cuuFits = (Number(m[1]) || 1) <= (out.rows || 24);
				if (cuuFits && !decxprActive) scrollUp = false;
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
		// Must stay strictly below POLL_MS: the "terminal didn't answer"
		// fallback has to fire before the next poll tick. An earlier version
		// had it the other way around (600 > 500) and unconditionally cleared
		// the previous timeout at the top of each poll — on a terminal that
		// never answers \x1b[6n the fallback therefore never ran: cleanup was
		// skipped forever, a new stdin listener leaked every 500 ms, and a
		// scrollUpStale flag set during streaming was never cleared, blocking
		// every deferred resize-resync from that point on.
		const TIMEOUT_MS = 400;

		let decxprActive = false;
		// Cancels the in-flight query (detaches its stdin listener + timeout);
		// null when none is active. Called by the effect cleanup so an unmount
		// mid-query doesn't leave a dangling listener.
		let cancelActiveQuery: (() => void) | null = null;

		function startQuery() {
			if (!process.stdin.isTTY) return;
			if (isTerminalSuspended()) return;
			// Skip during streaming — the live region is managed by Ink, not
			// the user, so the answer would be meaningless anyway.
			if (isStreamingActive()) return;
			// Previous query still unanswered (its own timeout will clean it
			// up before the next tick) — don't stack listeners.
			if (decxprActive) return;
			decxprActive = true;

			let buf = "";
			let active = true;
			let queryTimeout: ReturnType<typeof setTimeout> | null = null;

			function cleanup(scrolled: boolean) {
				if (!active) return;
				active = false;
				decxprActive = false;
				cancelActiveQuery = null;
				if (queryTimeout) clearTimeout(queryTimeout);
				process.stdin.off("data", onStdin);
				scrollUp = scrolled;
				// This poll only runs outside streaming/suspension, so its answer
				// is fresh — deferred resyncs may trust the flag again.
				scrollUpStale = false;
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
			cancelActiveQuery = () => cleanup(false);
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
			clearInterval(rawModeCheck);
			cancelActiveQuery?.();
			restore();
			process.off("exit", restore);
		};
	}, [onResync]);
}
