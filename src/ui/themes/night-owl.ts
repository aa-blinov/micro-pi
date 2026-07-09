import type { Theme } from "./types.ts";

export const nightOwl: Theme = {
	id: "night-owl",
	label: "Night Owl",
	description: "Colorful dark with blue focus — Sarah Drasner, VS Code",
	colors: {
		gradient: { from: "#82aaff", to: "#c792ea" },
		user: "#7fdbca",
		agent: "#c792ea",
		tool: "#82aaff",
		persona: "#c792ea",
		accent: "#82aaff",
		success: "#22da6e",
		warning: "#FFCA28",
		error: "#EF5350",
		muted: "#5f7e97",
	},
};
