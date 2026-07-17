import { describe, expect, it } from "vitest";
import { formatTaskToolSummary } from "../src/ui/task-tool-summary.ts";

describe("formatTaskToolSummary", () => {
	it("returns the full assignment text", () => {
		const assignment =
			"Review src/auth.ts for security issues. Check for: input validation, SQL injection, token handling. Report findings with file paths and line numbers.";
		expect(formatTaskToolSummary(JSON.stringify({ assignment }))).toBe(assignment);
	});

	it("does not emit JSON key=value dumps", () => {
		const text = formatTaskToolSummary(JSON.stringify({ assignment: "map mod-a", subagent: "worker" }));
		expect(text).toBe("map mod-a");
		expect(text).not.toContain("assignment=");
		expect(text).not.toContain("subagent=");
	});

	it("prefixes a non-default subagent name", () => {
		expect(formatTaskToolSummary(JSON.stringify({ assignment: "explore tree", subagent: "explore" }))).toBe(
			"explore · explore tree",
		);
	});

	it("returns null for incomplete or invalid args", () => {
		expect(formatTaskToolSummary("{")).toBeNull();
		expect(formatTaskToolSummary("{}")).toBeNull();
		expect(formatTaskToolSummary(JSON.stringify({ subagent: "worker" }))).toBeNull();
		expect(formatTaskToolSummary(JSON.stringify({ assignment: "   " }))).toBeNull();
	});

	it("caps pathological assignments", () => {
		const huge = "x".repeat(2500);
		const text = formatTaskToolSummary(JSON.stringify({ assignment: huge }));
		expect(text).not.toBeNull();
		expect(text!.endsWith("…")).toBe(true);
		expect(text!.length).toBe(2001);
	});
});
