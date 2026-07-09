import type { Theme } from "./types.ts";

/** Atom One Dark. */
export const oneDark: Theme = {
	id: "one-dark",
	label: "One Dark",
	description: "Atom's iconic dark scheme — balanced warm-cool contrast",
	colors: {
		gradient: { from: "#61afef", to: "#c678dd" },
		user: "#56b6c2",
		agent: "#c678dd",
		tool: "#61afef",
		persona: "#c678dd",
		accent: "#61afef",
		success: "#98c379",
		warning: "#e5c07b",
		error: "#e06c75",
		muted: "#5c6370",
	},
};
