import { createInterface } from "node:readline";
import type { ModelInfo } from "./config.ts";

/**
 * Populated whenever /v1/models has been fetched (selectModel, or the
 * background prefetch in main()). Empty until then, in which case the
 * completer below is a no-op. Kept behind get/set instead of a plain export
 * because ES module bindings for `let` exports can't be reassigned from
 * importing modules.
 */
let modelsCache: ModelInfo[] = [];

export function getModelsCache(): ModelInfo[] {
	return modelsCache;
}

export function setModelsCache(models: ModelInfo[]): void {
	modelsCache = models;
}

/** Tab-completes model ids against modelsCache, for both the bare "Model: "
 * prompt and the "/model <name>" command. */
function modelCompleter(line: string): [string[], string] {
	if (modelsCache.length === 0) return [[], line];

	const commandMatch = line.match(/^(\/model\s+)(\S*)$/);
	if (commandMatch) {
		const partial = commandMatch[2] ?? "";
		const hits = modelsCache.map((m) => m.id).filter((id) => id.startsWith(partial));
		return [hits, partial];
	}

	if (!line.startsWith("/")) {
		const hits = modelsCache.map((m) => m.id).filter((id) => id.startsWith(line));
		return [hits, line];
	}

	return [[], line];
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Stands in for a real newline while pasted text is being assembled into
 * the current line — see installBracketedPaste's doc comment for why a
 * literal "\n" can't be used here. A Unicode Private Use Area code point
 * essentially never occurs in real pasted text (source code, prose, JSON,
 * ...), so collisions aren't a practical concern. index.ts's "line" handler
 * converts it back to "\n" once the (real, keypress-driven) Enter that
 * finally submits the line arrives.
 */
export const PASTE_NEWLINE_PLACEHOLDER = "";

/**
 * node:readline has no built-in bracketed-paste support: without it, a
 * terminal paste containing embedded newlines looks identical to the user
 * pressing Enter after every line, and readline submits each one as its own
 * "line" event instead of the pasted block as one unit.
 *
 * Most terminals (Terminal.app, iTerm2, most Linux terminals, Windows
 * Terminal) support *bracketed paste*: once enabled via `\x1b[?2004h`, they
 * wrap anything pasted in `\x1b[200~ ... \x1b[201~` markers instead of
 * sending it as plain keystrokes. Two problems have to be solved to make
 * use of that, both confirmed the hard way by writing a small standalone
 * script and checking `rl.line`/the "line" event under a real pty rather
 * than assuming:
 *
 * 1. `rl.write(str)` is not a safe way to insert literal multi-line text.
 *    It runs `str` through the exact same per-character key-handling logic
 *    as real typed input, so an embedded "\n" in `str` submits a "line"
 *    event right then and there — identically to a real Enter keystroke —
 *    no matter that it arrived through `write()` rather than a keypress.
 *    So every real newline in the pasted text is swapped for
 *    PASTE_NEWLINE_PLACEHOLDER before insertion, and only swapped back once
 *    the whole thing is actually submitted (see index.ts's "line" handler).
 *
 * 2. `rl.pause()` looks like the obvious way to make readline ignore the
 *    marked span in the meantime, but it does nothing of the sort: the flag
 *    it sets is only ever consulted by `prompt()` to decide whether to
 *    auto-resume before redrawing, not by the internal keypress dispatcher
 *    that turns bytes into "line" events. Readline reacts to every
 *    keystroke-shaped byte regardless of `paused` — confirmed by
 *    reproducing a still-split paste with it in place. What actually stops
 *    readline from reacting is removing its own "data" listener from
 *    `process.stdin` for the paste's duration and reattaching it once the
 *    closing marker arrives. `createInterface()` on a TTY installs exactly
 *    one such listener (verified empirically); registering ours with
 *    `prependListener` puts it first in line, so we see every chunk before
 *    it does — including the first one, which carries the start marker and
 *    triggers the removal itself. Node's EventEmitter snapshots listeners
 *    per `emit()` call, so removing it mid-dispatch doesn't retroactively
 *    stop it from also seeing *that* chunk; the removal only guarantees
 *    it's gone for the chunks that follow, which is exactly the window
 *    that mattered in testing (a slow paste whose lines arrive as separate
 *    "data" events with a real gap in between).
 */
/**
 * Re-enables bracketed paste mode on the terminal. Called after SIGCONT
 * (fg) because some terminals reset private mode flags when a process is
 * suspended and resumed. Without this, pasting after fg degenerates to
 * plain keystrokes — each line fires its own "line" event instead of
 * arriving as one bracketed block.
 */
export function restoreBracketedPaste(): void {
	if (process.stdout.isTTY) process.stdout.write("\x1b[?2004h");
}

function installBracketedPaste(rl: ReturnType<typeof createInterface>): void {
	if (!process.stdin.isTTY) return;

	restoreBracketedPaste();
	rl.once("close", () => {
		if (process.stdout.isTTY) process.stdout.write("\x1b[?2004l");
	});

	// node:readline installs exactly one "data" listener on process.stdin.
	// We intercept all stdin data and decide what reaches readline
	// ourselves, because EventEmitter.emit() snapshots the listener list
	// before dispatch — any removeListener/addListener dance inside a
	// listener doesn't prevent already-snapshotted listeners from also
	// seeing the same chunk, causing double-insertion of pasted text.
	const readlineListener = process.stdin.listeners("data")[0] as ((chunk: Buffer) => void) | undefined;
	if (!readlineListener) return;

	process.stdin.removeAllListeners("data");

	let pasting = false;

	process.stdin.on("data", (chunk: Buffer) => {
		let text = chunk.toString("utf-8");

		if (!pasting && !text.includes(PASTE_START)) {
			// Normal keystrokes — pass to readline as-is.
			readlineListener(chunk);
			return;
		}

		for (;;) {
			if (!pasting) {
				const startIdx = text.indexOf(PASTE_START);
				if (startIdx === -1) {
					// Leftover bytes after a previous paste ended.
					// Pass them to readline so trailing Enter etc. works.
					if (text) readlineListener(Buffer.from(text));
					return;
				}
				// Bytes before the paste start marker are normal input.
				if (startIdx > 0) readlineListener(Buffer.from(text.slice(0, startIdx)));
				text = text.slice(startIdx + PASTE_START.length);
				pasting = true;
			}

			const endIdx = text.indexOf(PASTE_END);
			const interior = endIdx === -1 ? text : text.slice(0, endIdx);
			if (interior) rl.write(interior.replace(/\r\n|\r|\n/g, PASTE_NEWLINE_PLACEHOLDER));
			if (endIdx === -1) return;

			text = text.slice(endIdx + PASTE_END.length);
			pasting = false;
			if (text.length === 0) return;
			// Loop back: leftover could contain another paste or normal input.
		}
	});
}

/** Count of pending rl.question() calls. When > 0, the standing "line"
 *  handler must skip input to avoid double-processing. */
let activeQuestions = 0;
export function isQuestionActive(): boolean {
	return activeQuestions > 0;
}

export function createRl() {
	const rl = createInterface({ input: process.stdin, output: process.stdout, completer: modelCompleter });
	installBracketedPaste(rl);
	return rl;
}

export function ask(rl: ReturnType<typeof createRl>, prompt: string): Promise<string> {
	activeQuestions++;
	return new Promise((resolve) =>
		rl.question(prompt, (answer) => {
			activeQuestions--;
			// question() intercepts "line" events before index.ts's
			// debounce handler, so PASTE_NEWLINE_PLACEHOLDER wouldn't
			// get restored otherwise.
			resolve(answer.replaceAll(PASTE_NEWLINE_PLACEHOLDER, "\n"));
		}),
	);
}
