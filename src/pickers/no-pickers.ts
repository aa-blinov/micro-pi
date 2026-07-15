import type { Pickers } from "./types.ts";

/**
 * Pickers implementation that immediately exits if invoked. Used by non-
 * interactive mode (`cast run`) where the user's saved config must already
 * have a model and persona — if either is missing, prompting interactively
 * would hang forever, so we bail with a clear message instead.
 */
export const noPickers: Pickers = {
	pickOption(_options, opts) {
		console.error(`Cannot prompt in non-interactive mode: ${opts?.title ?? "selection"} required.`);
		console.error("Run `cast` interactively first to configure model and persona.");
		process.exit(1);
	},
	promptText(label) {
		console.error(`Cannot prompt in non-interactive mode: "${label}" required.`);
		console.error("Run `cast` interactively first to configure model and persona.");
		process.exit(1);
	},
	pickMulti(_options, opts) {
		console.error(`Cannot prompt in non-interactive mode: ${opts?.title ?? "multi-selection"} required.`);
		console.error("Run `cast` interactively first to configure model and persona.");
		process.exit(1);
	},
	log(text) {
		process.stderr.write(`${text}\n`);
	},
};
