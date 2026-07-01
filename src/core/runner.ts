import { MessageQueue } from "./loop.ts";

// ============================================================================
// Agent runner (manages queues and prompt execution)
// ============================================================================

export interface AgentRunner {
	steeringQueue: MessageQueue;
	followUpQueue: MessageQueue;
	/** True while the agent loop is running. */
	isRunning: boolean;
	/** Abort the current run. */
	abort: () => void;
	/** Promise that resolves when the current run finishes. */
	waitForIdle: () => Promise<void>;
	/** Mark a run as started; called by runPrompt. */
	startRun: (ac: AbortController) => void;
	/** Mark a run as finished; called by runPrompt. */
	endRun: () => void;
}

export function createAgentRunner(): AgentRunner {
	let currentAbort: AbortController | null = null;
	let idleResolve: (() => void) | null = null;

	const runner: AgentRunner = {
		steeringQueue: new MessageQueue(),
		followUpQueue: new MessageQueue(),
		isRunning: false,

		abort() {
			currentAbort?.abort();
			// Anything queued for this run is moot once it's cancelled —
			// otherwise a /steer or /queue typed just before /abort would
			// silently surface at the start of the next, unrelated prompt.
			runner.steeringQueue.clear();
			runner.followUpQueue.clear();
		},

		waitForIdle() {
			if (!runner.isRunning) return Promise.resolve();
			return new Promise<void>((resolve) => {
				idleResolve = resolve;
			});
		},

		startRun(ac: AbortController) {
			currentAbort = ac;
			runner.isRunning = true;
		},
		endRun() {
			runner.isRunning = false;
			currentAbort = null;
			if (idleResolve) {
				idleResolve();
				idleResolve = null;
			}
		},
	};

	return runner;
}
