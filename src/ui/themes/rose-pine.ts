import type { Theme } from "./types.ts";

/** Rosé Pine — the dark main variant. */
export const rosePine: Theme = {
	id: "rose-pine",
	label: "Rosé Pine",
	description: "Soft natural dark — all natural pine, faux fur and a bit of soho",
	colors: {
		gradient: { from: "#9ccfd8", to: "#c4a7e7" },
		user: "#9ccfd8",
		agent: "#c4a7e7",
		tool: "#c4a7e7",
		persona: "#ebbcba",
		accent: "#c4a7e7",
		success: "#78c0a0",
		warning: "#f6c177",
		error: "#eb6f92",
		muted: "#6e6a86",
	},
};
