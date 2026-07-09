import type { Theme } from "./types.ts";

export const tokyoNight: Theme = {
	id: "tokyo-night",
	label: "Tokyo Night",
	description: "Night city lights — VS Code bestseller, inspired by Tokyo at night",
	colors: {
		gradient: { from: "#7aa2f7", to: "#bb9af7" },
		user: "#7dcfff",
		agent: "#bb9af7",
		tool: "#7aa2f7",
		persona: "#bb9af7",
		accent: "#7aa2f7",
		success: "#73daca",
		warning: "#e0af68",
		error: "#f7768e",
		muted: "#565f89",
	},
};
