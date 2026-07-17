import { describe, expect, it } from "vitest";
import {
	buildOpenWorkGateExhaustedReminder,
	buildOpenWorkGateReminder,
	DEFAULT_OPEN_WORK_GATE_MAX_FIRES,
	defaultOpenWorkGateConfig,
	evaluateOpenWorkGate,
} from "../src/core/open-work-gate.ts";

describe("evaluateOpenWorkGate", () => {
	it("continues when there are no open steps", () => {
		expect(evaluateOpenWorkGate({ openSteps: [] })).toEqual({ type: "continue" });
	});

	it("nudges with a reminder listing the provided open steps", () => {
		const openSteps = ["step alpha", "step beta"];
		const decision = evaluateOpenWorkGate({ openSteps });
		expect(decision.type).toBe("nudge");
		if (decision.type !== "nudge") return;
		expect(decision.reminder).toContain("<system-reminder>");
		expect(decision.reminder).toContain("</system-reminder>");
		for (const step of openSteps) {
			expect(decision.reminder).toContain(`- ${step}`);
		}
		expect(decision.reminder).toContain("ended your turn without a tool call");
	});
});

describe("buildOpenWorkGateReminder", () => {
	it("wraps the body in system-reminder tags", () => {
		const reminder = buildOpenWorkGateReminder(["only"]);
		expect(reminder.startsWith("<system-reminder>\n")).toBe(true);
		expect(reminder.endsWith("\n</system-reminder>")).toBe(true);
		expect(reminder).toContain("- only");
	});
});

describe("buildOpenWorkGateExhaustedReminder", () => {
	it("includes the max-fires cap number", () => {
		const reminder = buildOpenWorkGateExhaustedReminder(2);
		expect(reminder).toContain("<system-reminder>");
		expect(reminder).toContain("2 times");
		expect(reminder).toContain("Falling through to the user");
	});
});

describe("defaultOpenWorkGateConfig", () => {
	it("defaults to enabled with maxFiresPerPrompt of 2", () => {
		const cfg = defaultOpenWorkGateConfig();
		expect(cfg.enabled).toBe(true);
		expect(cfg.maxFiresPerPrompt).toBe(2);
		expect(DEFAULT_OPEN_WORK_GATE_MAX_FIRES).toBe(2);
	});
});
