import type { Theme } from "./types.ts";

/** Solarized Dark. */
export const solarized: Theme = {
	id: "solarized",
	label: "Solarized",
	description: "Precision engineered dark palette — Ethan Schoonover, 2011",
	colors: {
		gradient: { from: "#268bd2", to: "#2aa198" },
		user: "#2aa198",
		agent: "#6c71c4",
		tool: "#268bd2",
		persona: "#d33682",
		accent: "#268bd2",
		success: "#859900",
		warning: "#b58900",
		error: "#dc322f",
		muted: "#586e75",
	},
};
