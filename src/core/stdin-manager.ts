/**
 * StdinManager — coordinates stdin ownership between Ink's Composer and
 * child processes that may need interactive input (e.g. git push asking for
 * a password).
 *
 * Problem: Ink sets stdin to raw mode and installs a data handler for
 * keystroke-by-keystroke processing. A child process spawned with
 * stdio: ["pipe", …] would never see user input because Ink intercepts it.
 *
 * Solution: Before spawning a command that might need stdin, call
 * suspendAndRun() which (a) suspends Ink's renderer (clears screen,
 * disables raw mode), (b) pipes process.stdin to the child, and
 * (c) resumes Ink when the child exits.
 */

export interface StdinOwner {
	/** Unique label for debugging. */
	id: string;
	/** Called when this owner should stop reading stdin. */
	onPause: () => void;
	/** Called when this owner should resume reading stdin. */
	onResume: () => void;
}

let currentOwner: StdinOwner | null = null;

/** True while a child process owns the terminal (suspendAndRun is active). */
let terminalSuspended = false;

/** Number of concurrent suspendAndRun calls that paused the owner. */
let pauseDepth = 0;

/** True while the agent is actively streaming tokens (between submit and finally). */
let streamingActive = false;

/**
 * Full terminal suspend/resume hook registered by the UI layer.
 * The callback runs while the terminal is suspended (Ink's frame cleared,
 * raw mode off). The hook must await the callback before returning.
 */
type SuspendHook = (callback: () => Promise<void>) => Promise<void>;
let suspendHook: SuspendHook | null = null;

/**
 * Register the primary stdin consumer (the Composer). Only one owner is
 * active at a time; calling register() replaces any previous owner.
 */
export function registerStdinOwner(owner: StdinOwner): void {
	currentOwner = owner;
}

/** Unregister the current owner (e.g. on component unmount). */
export function unregisterStdinOwner(owner: StdinOwner): void {
	if (currentOwner === owner) currentOwner = null;
}

/**
 * Register the full-terminal suspend hook. Called once from tui.tsx after
 * Ink mounts, wiring up Ink's suspendTerminal().
 */
export function setSuspendHook(hook: SuspendHook): void {
	suspendHook = hook;
}

/**
 * Suspend the terminal (Ink clears its frame, disables raw mode) and run
 * the callback. While suspended, the child process owns stdin/stdout
 * directly. The callback's resolved value is returned to the caller.
 *
 * If no suspend hook is registered (e.g. non-TUI mode), the callback
 * runs without suspension.
 */
export async function suspendAndRun<T>(callback: () => Promise<T>): Promise<T> {
	if (!suspendHook) return callback();
	let result: T;
	// Snapshot before we touch the flag — if another concurrent suspendAndRun
	// already holds the terminal, we must not clear it when ours fails.
	const wasSuspended = terminalSuspended;
	// Pause the Composer's stdin handler before Ink suspends, so that
	// keystrokes during the child process don't leak into the Composer.
	// Only the outermost concurrent caller actually pauses.
	if (pauseDepth++ === 0) currentOwner?.onPause();
	terminalSuspended = true;
	try {
		await suspendHook(async () => {
			result = await callback();
		});
	} catch {
		// suspendTerminal throws if already suspended (parallel bash calls).
		// Fall back to running without terminal suspension — but only clear
		// the flag if we were the one who set it (not a concurrent caller).
		if (!wasSuspended) terminalSuspended = false;
		result = await callback();
	} finally {
		if (!wasSuspended) terminalSuspended = false;
		// Only the outermost concurrent caller resumes.
		if (--pauseDepth === 0) currentOwner?.onResume();
	}
	return result!;
}

export function isTerminalSuspended(): boolean {
	return terminalSuspended;
}

/** Mark streaming as active or inactive. Called by useAgentSession. */
export function setStreamingActive(active: boolean): void {
	streamingActive = active;
}

/** Whether the agent is actively streaming tokens. */
export function isStreamingActive(): boolean {
	return streamingActive;
}
