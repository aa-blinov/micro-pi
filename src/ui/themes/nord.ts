import type { Theme } from "./types.ts";

export const nord: Theme = {
	id: "nord",
	label: "Nord",
	description: "Arctic blue-gray — clean, minimal, frost-inspired",
	colors: {
		gradient: { from: "#88c0d0", to: "#81a1c1" },
		user: "#88c0d0",
		agent: "#b48ead",
		tool: "#81a1c1",
		persona: "#b48ead",
		accent: "#88c0d0",
		success: "#a3be8c",
		warning: "#ebcb8b",
		error: "#bf616a",
		muted: "#4c566a",
	},
};
