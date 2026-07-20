import { useEffect } from "react";
import {
	consumeLastTurnAborted,
	isStreamingActive,
	isTerminalSuspended,
	setLastFrameOverflow,
} from "../core/stdin-manager.ts";

// Ink's log-update erases a taller-than-one-line frame via ansi-escapes'
// eraseLines() (node_modules/ansi-escapes/base.js), which emits one
// *separate* `\x1b[1A` per line (`\x1b[2K\x1b[1A` repeated) rather than a
// single combined `\x1b[<n>A`. Some terminals (observed: Termius on mobile)
// mishandle several byte-identical escape sequences arriving back-to-back
// in one write — the cursor ends up fewer rows above its target than Ink
// assumes, the redraw lands lower than intended, and the un-erased top of
// the previous frame is left on screen. Repeated once per keystroke, this
// stacks into dozens of orphaned top-border fragments (reproduced and
// confirmed fixed via a debug capture — Termius + a composer frame taller
// than one line). Rewriting the whole per-line erase run into a single
// combined cursor-up + erase-to-end-of-screen (`\x1b[<n>A\x1b[J`) fixes it
// and is equivalent for terminals that handled the original sequence fine,
// so it's applied unconditionally rather than behind a compatibility flag.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ansi-escapes eraseLines() output
const ERASE_LINES_RUN_RE = /(?:\x1b\[2K\x1b\[1A)+\x1b\[2K\x1b\[G/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: counting hops within a matched run
const CUU_HOP_RE = /\x1b\[1A/g;
function coalesceEraseLines(s: string): string {
	return s.replace(ERASE_LINES_RUN_RE, (match) => {
		const hops = match.match(CUU_HOP_RE)?.length ?? 0;
		return hops > 0 ? `\x1b[${hops}A\x1b[J` : match;
	});
}

/**
 * Two distinct terminal desyncs, one shared remedy (clear + full <Static>
 * replay via the onResync callback):
 *
 * 1. Resize/reflow (VS Code, iTerm) re-wraps on-screen lines — Ink only
 *    self-corrects on width *decrease*; width increases and height changes
 *    leave stale copies of the live region stacked on screen. Debounced so a
 *    drag-resize burst triggers one reset once it settles.
 *
 * 1b. Focus regain (alt-tab). While the window is unfocused the terminal
 *    (Termius, and others) may throttle or coalesce rendering and reset the
 *    scroll region, so Ink's cursor-relative incremental frames stack up —
 *    the composer's top border reappears several times over. The terminal
 *    itself emits no resize, so nothing triggered a redraw; the only known
 *    workaround was to resize manually. We now enable focus reporting
 *    (\x1b[?1004h) and treat a focus-in report (\x1b[I) as the same desync
 *    signal as a resize, running the shared remedy once the run settles.
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
 *       reports row > height. While streaming with a *short* live region
 *       (CUU fits the screen — e.g. a few parallel `[running]` rows), polls
 *       stay on so trackpad inertia can arm the guard. While the live region
 *       is taller than the viewport, row > height is normal terminal scroll,
 *       not user scroll — polling then would false-positive, swallow Ink
 *       frames, and scramble scrollback order. The response also reaches the
 *       other stdin consumers (Ink maps a CSI-R final to a bare f3 key; the
 *       composer drops unmatched CSI). A 500 ms interval keeps the flag fresh.
 *
 *    Either signal triggers the guard: cursor/erase writes are swallowed
 *    until the user scrolls back to the bottom.
 *
 * The resync itself has two tiers:
 *
 * - Light (resize, focus-regain): \x1b[2J (clear visible screen) + \x1b[H
 *   (cursor home) + <Static> replay. No \x1b[3J scrollback wipe — the
 *   scrollback content is still valid (reflowed by the terminal on resize,
 *   or untouched on focus), so wiping it would destroy the user's scroll
 *   position for no reason and cause a visible flash while the full history
 *   replays. The banner stays in scrollback from the initial print.
 *
 * - Full (theme change, streaming desync): \x1b[2J + \x1b[3J (wipe
 *   scrollback) + banner reprint + <Static> replay. The old gradient banner
 *   must be wiped because the new one has different colors.
 *
 * Both tiers are deferred while streaming is active (isStreamingActive, set
 * by useAgentSession), while a child process owns the terminal
 * (suspendAndRun), or while the user is scrolled up — clearing at any of
 * those moments would erase what they're looking at. It fires once
 * conditions clear. No-op resize events (SIGWINCH without an actual size
 * change, e.g. tmux pane focus) are ignored entirely.
 */
/**
 * Decides whether a streaming turn ended in a state that needs one cleanup
 * repaint. Pure and self-contained (no terminal I/O) so the "only repaint when
 * a desync was actually observed" guarantee is unit-testable.
 *
 * - noteFrame(cuuFits, streaming): call per rendered frame. A frame whose live
 *   area is taller than the viewport (`cuuFits === false`) while streaming is
 *   the condition under which spinner/frame redraws stack — it arms the tracker.
 * - onPoll(streaming): call once per poll tick. Returns true exactly once, on
 *   the streaming→idle edge, and only if a stacking frame was seen during the
 *   turn. A turn whose frames all fit never returns true, so no repaint is paid.
 */
export function createDesyncTracker(streamingNow: boolean): {
	noteFrame(cuuFits: boolean, streaming: boolean): void;
	onPoll(streaming: boolean): boolean;
} {
	let armed = false;
	let wasStreaming = streamingNow;
	return {
		noteFrame(cuuFits, streaming) {
			if (!cuuFits && streaming) armed = true;
		},
		onPoll(streaming) {
			const request = wasStreaming && !streaming && armed;
			if (!streaming) armed = false;
			wasStreaming = streaming;
			return request;
		},
	};
}

/**
 * Distinguishes a genuine alt-tab return (window lost focus, then regained it)
 * from the spurious focus-in some terminals emit the moment focus reporting is
 * enabled. Only a focus-in that FOLLOWS a focus-out should trigger a resync —
 * acting on the startup focus-in would clear the freshly printed banner, which
 * lives outside Ink's <Static> and so isn't restored by the resync's replay.
 * Pure so the rule is unit-testable.
 */
export function createFocusReturnTracker(): { onData(data: string): boolean } {
	let sawFocusOut = false;
	return {
		onData(data) {
			if (data.includes("\x1b[O")) sawFocusOut = true; // focus lost
			if (!data.includes("\x1b[I")) return false; // no focus-in in this chunk
			if (!sawFocusOut) return false; // focus-in with no prior loss — ignore
			sawFocusOut = false;
			return true;
		},
	};
}

export function useTerminalResync(onResync: (preserveScrollback: boolean) => void): void {
	useEffect(() => {
		const out = process.stdout;
		if (!out.isTTY) return;

		const origWrite = out.write.bind(out);

		// --- scroll guard state (shared by both detection layers) ---
		let scrollUp = false;
		// Last Ink frame's CUU distance fit the viewport. Tall streaming frames
		// make DECXCPR row>height meaningless (natural overflow); short frames
		// (spinner / parallel task lines) make it a real user-scroll signal.
		let liveFits = true;
		// scrollUp is refreshed by the DECXCPR poll. Polls skip while suspended,
		// and while streaming with a tall live region. Right after those end the
		// flag can be stale — a resync must not trust a stale "not scrolled".
		// Set stale while streaming/suspended; cleared by every completed poll.
		let scrollUpStale = false;

		// --- resize: debounce a settle, then hard reset ---
		let resizeTimer: ReturnType<typeof setTimeout> | null = null;
		let resyncPending = false;

		// One-shot cleanup repaint after a streaming turn — but only when the live
		// area outgrew the viewport mid-stream, the condition under which Ink's
		// in-place spinner/frame redraw can stack into scrollback (scroll guard
		// swallows cursor/erase while scrolled, but tall frames can still leave
		// stacked artifacts once the turn settles). Gating on real evidence means
		// an ordinary turn whose frames fit triggers no clear/replay at all.
		const desyncTracker = createDesyncTracker(isStreamingActive());
		// Last known size, to drop no-op SIGWINCH events (tmux pane focus,
		// VS Code panel toggles) that fire "resize" without changing anything —
		// each one used to cost a full clear (+ scrollback wipe via \x1b[3J),
		// resetting the user's scroll position for no reason.
		let lastCols = out.columns;
		let lastRows = out.rows;

		// Whether the scroll flag can be trusted right now. Non-TTY stdin never
		// polls, so staleness can't clear there — don't let it block forever.
		const scrollKnown = () => !scrollUpStale || !process.stdin.isTTY;

		// The clear below and the replayed frame it triggers (via onResync's state
		// update, flushed by Ink on a later tick) are two separate writes with a
		// gap between them — long enough for the terminal to paint the blank
		// cleared screen before the redraw lands, i.e. a visible flash. Wrapping
		// both in CSI ?2026h/l (synchronized output — the same mechanism Ink uses
		// internally for its own frames, see ink's write-synchronized.js) tells
		// the terminal to buffer everything until the closing marker and swap
		// atomically. `setImmediate` gives Ink's next frame time to land before
		// releasing; the timeout is a safety net so a delayed/failed commit can't
		// leave the terminal stuck buffering output forever.
		let releaseSync: (() => void) | null = null;
		const withSyncedRepaint = (clearSeq: string, resync: () => void) => {
			releaseSync?.(); // shouldn't overlap, but never leave a prior one dangling
			origWrite("\x1b[?2026h");
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				releaseSync = null;
				origWrite("\x1b[?2026l");
			};
			releaseSync = release;
			const safety = setTimeout(release, 250);
			try {
				origWrite(clearSeq);
				resync();
			} finally {
				setImmediate(() => {
					clearTimeout(safety);
					release();
				});
			}
		};

		// Full clear: wipes scrollback (\x1b[3J) so the old banner disappears
		// and the fresh one is the only copy. Used by theme changes.
		const doFullResync = () => {
			if (isStreamingActive() || isTerminalSuspended() || scrollUp || !scrollKnown()) {
				resyncPending = true;
				return;
			}
			resyncPending = false;
			// After the clear + cursor-home the terminal is at a known position.
			// Reset scroll flags so the next Ink frame isn't swallowed by the
			// scroll guard while waiting for the next DECXCPR poll (up to 500ms).
			scrollUp = false;
			scrollUpStale = false;
			withSyncedRepaint("\x1b[2J\x1b[3J\x1b[H", () => onResync(false));
		};
		// Light clear: only the visible screen (\x1b[2J), no scrollback wipe.
		// Used by resize and focus-regain — the scrollback content is still
		// valid (reflowed by the terminal on resize, or untouched on focus),
		// so wiping it would destroy the user's scroll position for no reason
		// and cause a visible flash while the full history replays.
		const doLightResync = () => {
			if (isStreamingActive() || isTerminalSuspended() || scrollUp || !scrollKnown()) {
				resyncPending = true;
				return;
			}
			resyncPending = false;
			scrollUp = false;
			scrollUpStale = false;
			withSyncedRepaint("\x1b[2J\x1b[H", () => onResync(true));
		};

		const onResize = () => {
			// Ignore spurious resize events where the size didn't actually change.
			if (out.columns === lastCols && out.rows === lastRows) return;
			lastCols = out.columns;
			lastRows = out.rows;
			if (resizeTimer) clearTimeout(resizeTimer);
			resizeTimer = setTimeout(doLightResync, 80);
		};
		out.on("resize", onResize);

		// --- focus regain: enable focus reporting, resync on focus-in ---
		// \x1b[?1004h asks the terminal to report focus changes as \x1b[I
		// (in) / \x1b[O (out). Terminals that don't support it ignore the
		// request. The composer's input parser drops both reports explicitly.
		let focusReportingOn = false;
		if (process.stdin.isTTY) {
			origWrite("\x1b[?1004h");
			focusReportingOn = true;
		}
		const focusTracker = createFocusReturnTracker();
		let focusTimer: ReturnType<typeof setTimeout> | null = null;
		// biome-ignore lint/suspicious/noControlCharactersInRegex: focus report sequences
		const FOCUS_RE = /\x1b\[IO/g;
		const onFocusData = (chunk: Buffer) => {
			const s = chunk.toString("latin1");
			// Process focus sequences for the tracker first.
			if (focusTracker.onData(s)) {
				if (focusTimer) clearTimeout(focusTimer);
				focusTimer = setTimeout(doLightResync, 80);
			}
			// Strip focus sequences in-place so they don't reach Ink's useInput.
			// Without this, \x1b can be parsed as an Escape keypress by readline,
			// which breaks modal pickers (StatusBarPicker, etc.) after alt-tab.
			if (FOCUS_RE.test(s)) {
				FOCUS_RE.lastIndex = 0;
				const cleaned = s.replace(FOCUS_RE, "");
				const cleanedBuf = Buffer.from(cleaned, "latin1");
				cleanedBuf.copy(chunk);
				for (let i = cleanedBuf.length; i < chunk.length; i++) chunk[i] = 0;
			}
		};
		if (process.stdin.isTTY) process.stdin.on("data", onFocusData);

		// Flush a deferred resync once streaming ends / terminal is released /
		// the user scrolls back to the bottom — but only after a fresh poll has
		// confirmed the scroll state (see scrollUpStale above). Uses the full
		// path (doFullResync) because a streaming desync may need the banner
		// reprinted after the live region stacked above it.
		const checkDeferredResync = () => {
			const streamingNow = isStreamingActive();
			// Streaming just ended after the live area outgrew the viewport at some
			// point during it — request one cleanup repaint. It rides the same
			// deferral/guards below (scroll, suspend, scroll-known), so it never
			// clears while the user is scrolled up reading. Skipped when the turn
			// that just ended was aborted (Esc): the user just interrupted the
			// run, and a full clear + scrollback wipe + <Static> replay landing
			// right then is more jarring than the stacked-frame garbage it would
			// clean up — that cleanup rides along on the next turn that actually
			// completes/overflows instead. consumeLastTurnAborted() must only be
			// called here, exactly on the edge onPoll fires on, or it could
			// suppress a later, unrelated turn's genuine cleanup.
			if (desyncTracker.onPoll(streamingNow) && !consumeLastTurnAborted()) resyncPending = true;

			if (streamingNow || isTerminalSuspended()) {
				scrollUpStale = true;
				return;
			}
			if (resyncPending && !scrollUp && scrollKnown()) {
				if (resizeTimer) clearTimeout(resizeTimer);
				resizeTimer = setTimeout(doFullResync, 80);
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
			let s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			// See coalesceEraseLines above — rewrite Ink's per-line erase run into
			// one combined cursor-up + erase-to-end-of-screen before anything else
			// (including the CUU_RE check below) sees it.
			let coalesced = false;
			if (ERASE_LINES_RUN_RE.test(s)) {
				ERASE_LINES_RUN_RE.lastIndex = 0;
				const rewritten = coalesceEraseLines(s);
				if (rewritten !== s) {
					s = rewritten;
					coalesced = true;
				}
			}

			// log-update starts each frame with `\x1b[<n>A` (move up past the
			// previous frame). n > terminal rows means the live area doesn't fit
			// on screen. Recompute both directions so the guard can never latch.
			// This CUU_RE check must run on every frame (it's the only source of
			// liveFits/desyncTracker truth) — it's cheap (one small regex against
			// the start of the string), unlike the CURSOR_OR_ERASE_RE scan below,
			// which is skipped unless scrollUp is actually latched.
			const m = CUU_RE.exec(s);
			if (m) {
				// During streaming the live area routinely exceeds terminal height —
				// Ink handles that by letting the terminal scroll naturally. Only
				// DECXCPR (layer b) can reliably detect *user*-initiated scroll,
				// so never latch scrollUp from the CUU heuristic alone.
				const cuuN = Number(m[1]) || 1;
				const rows = out.rows || 24;
				const cuuFits = cuuN <= rows;
				const streamingNow = isStreamingActive();
				liveFits = cuuFits;
				setLastFrameOverflow(Math.max(0, cuuN - rows));
				// Never clear scrollUp from CUU while streaming: a short spinner
				// frame (cuuFits) would unlock Ink redraws while the user is still
				// scrolled into history — trackpad inertia then fights CUU and the
				// viewport jumps to the top. Idle clears stay DECXCPR-driven too
				// when a poll is in flight; only clear here when idle + no poll.
				if (cuuFits && !decxprActive && !streamingNow) scrollUp = false;
				// A live area taller than the viewport while streaming is when
				// spinner/frame redraws can stack. Remember it; the cleanup repaint
				// happens once the turn settles (see checkDeferredResync).
				desyncTracker.noteFrame(cuuFits, streamingNow);
			}

			// The broad erase/cursor scan only matters once scrollUp is actually
			// latched — skip it otherwise (the common case) to avoid regex cost
			// on every frame during normal idle/streaming rendering.
			if (scrollUp && CURSOR_OR_ERASE_RE.test(s)) {
				return true; // swallow — don't erase/redraw while scrolled
			}
			return coalesced ? origWrite(s, ...args) : origWrite(chunk, ...args);
		} as typeof out.write;

		// --- layer (b): DECXCPR cursor-position polling ---
		// biome-ignore lint/suspicious/noControlCharactersInRegex: DECXCPR response format
		const DECXCPR_RE = /\x1b\[(\d+);(\d+)R/;
		const QUERY = "\x1b[6n";
		// "Terminal didn't answer" fallback. startQuery's `decxprActive` guard
		// skips a tick outright while a query is still in flight, so a slow
		// terminal just loses polls rather than stacking listeners — but this
		// timeout still has to resolve *some* time, or `decxprActive` never
		// clears and every later tick gets skipped forever. An earlier version
		// had this fallback fire *after* the next poll tick (600ms vs. a 500ms
		// poll) and unconditionally cleared the previous timeout at the top of
		// each poll — on a terminal that never answers \x1b[6n the fallback
		// therefore never ran: cleanup was skipped forever, a new stdin
		// listener leaked every tick, and a scrollUpStale flag set during
		// streaming was never cleared, blocking every deferred resize-resync
		// from that point on.
		const TIMEOUT_MS = 400;

		let decxprActive = false;
		// Cancels the in-flight query (detaches its stdin listener + timeout);
		// null when none is active. Called by the effect cleanup so an unmount
		// mid-query doesn't leave a dangling listener.
		let cancelActiveQuery: (() => void) | null = null;

		function startQuery() {
			if (!process.stdin.isTTY) return;
			if (isTerminalSuspended()) return;
			// Tall live region while streaming: cursor sits below the viewport by
			// design — DECXCPR would false-positive scrollUp, swallow Ink frames,
			// and scramble scrollback (looks like "broken message order").
			// Short live region (fits): poll so trackpad inertia mid-run can latch.
			if (isStreamingActive() && !liveFits) return;
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
				// Belt-and-suspenders: never latch scrollUp from a poll that raced
				// into a tall streaming frame after startQuery was allowed.
				const streamingNow = isStreamingActive();
				scrollUp = scrolled && streamingNow && !liveFits ? false : scrolled;
				// Fresh DECXCPR answer — deferred resyncs may trust the flag again.
				scrollUpStale = false;
			}

			function onStdin(chunk: Buffer) {
				if (!active) return;
				buf += chunk.toString();
				// The DECXCPR response (\x1b[row;colR) also reaches the Composer's
				// StdinBuffer via its own stdin listener on the same stream. That's
				// safe: StdinBuffer parses it as a complete CSI sequence and
				// InputParser explicitly drops it (see input-parser.ts). We process
				// it independently here — no coordination needed.
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

		// Adaptive polling: fast (200ms) while streaming or when a resync is
		// pending (the scroll flag matters most then); slow (1000ms) at idle
		// to reduce unnecessary terminal traffic on mobile. Computed fresh on
		// mount too — opening the CLI is almost always idle, and mobile is the
		// case this exists to go easy on, so it shouldn't run fast for 3s
		// before the periodic check below picks the right rate.
		const initialPollRate = isStreamingActive() || resyncPending ? 200 : 1000;
		let pollInterval = setInterval(startQuery, initialPollRate);
		let lastPollRate = initialPollRate;
		const updatePollRate = () => {
			const rate = isStreamingActive() || resyncPending ? 200 : 1000;
			if (rate !== lastPollRate) {
				clearInterval(pollInterval);
				pollInterval = setInterval(startQuery, rate);
				lastPollRate = rate;
			}
		};
		// Check rate every few seconds — cheap, only resets the interval when needed.
		const rateCheck = setInterval(updatePollRate, 3000);

		const restore = () => {
			out.write = origWrite;
			// Stop the terminal reporting focus once we're no longer listening,
			// so a later plain shell doesn't receive \x1b[I / \x1b[O noise.
			if (focusReportingOn) {
				origWrite("\x1b[?1004l");
				focusReportingOn = false;
			}
		};
		process.on("exit", restore);

		return () => {
			out.off("resize", onResize);
			if (resizeTimer) clearTimeout(resizeTimer);
			if (focusTimer) clearTimeout(focusTimer);
			process.stdin.off("data", onFocusData);
			clearInterval(pollInterval);
			clearInterval(rateCheck);
			clearInterval(rawModeCheck);
			cancelActiveQuery?.();
			releaseSync?.();
			restore();
			process.off("exit", restore);
		};
	}, [onResync]);
}
