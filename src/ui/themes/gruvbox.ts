import type { Theme } from "./types.ts";

export const gruvbox: Theme = {
	id: "gruvbox",
	label: "Gruvbox",
	description: "Retro groove warm tones — Pavel Pertsev",
	colors: {
		gradient: { from: "#fabd2f", to: "#d3869b" },
		user: "#83a598",
		agent: "#d3869b",
		tool: "#fabd2f",
		persona: "#d3869b",
		accent: "#fabd2f",
		success: "#b8bb26",
		warning: "#fabd2f",
		error: "#fb4934",
		muted: "#928374",
	},
};
