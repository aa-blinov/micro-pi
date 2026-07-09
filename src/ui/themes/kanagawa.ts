import type { Theme } from "./types.ts";

/** Kanagawa — inspired by Katsushika Hokusai's paintings. */
export const kanagawa: Theme = {
	id: "kanagawa",
	label: "Kanagawa",
	description: "Japanese ink painting — colors from Hokusai's Great Wave",
	colors: {
		gradient: { from: "#7e9cd8", to: "#957fb8" },
		user: "#7fb4ca",
		agent: "#957fb8",
		tool: "#7e9cd8",
		persona: "#957fb8",
		accent: "#7e9cd8",
		success: "#98bb6c",
		warning: "#dca561",
		error: "#c34043",
		muted: "#727169",
	},
};
