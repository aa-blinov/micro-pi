import { describe, expect, it } from "vitest";
import { lineChurn } from "../src/ui/ChatLog.tsx";

describe("lineChurn", () => {
	it("reports no churn for identical text", () => {
		expect(lineChurn("a\nb\nc", "a\nb\nc")).toEqual({ added: 0, removed: 0 });
	});

	it("counts only the changed line inside an otherwise-identical block (the whole point of the LCS)", () => {
		// One line tweaked in a 6-line block reads as +1/-1, not +6/-6.
		const oldText = "l1\nl2\nl3\nl4\nl5\nl6";
		const newText = "l1\nl2\nCHANGED\nl4\nl5\nl6";
		expect(lineChurn(oldText, newText)).toEqual({ added: 1, removed: 1 });
	});

	it("counts a pure insertion as added only", () => {
		expect(lineChurn("a\nb", "a\nNEW\nb")).toEqual({ added: 1, removed: 0 });
	});

	it("counts a pure deletion as removed only", () => {
		expect(lineChurn("a\nGONE\nb", "a\nb")).toEqual({ added: 0, removed: 1 });
	});

	it("treats fully-different blocks as all-removed + all-added", () => {
		expect(lineChurn("x\ny", "p\nq\nr")).toEqual({ added: 3, removed: 2 });
	});

	it("empty vs empty is a single unchanged (empty) line", () => {
		expect(lineChurn("", "")).toEqual({ added: 0, removed: 0 });
	});

	it("falls back to a block count (no LCS) past the O(m·n) size cap", () => {
		// 501×501 = 251_001 > 250_000 → fallback. Identical texts would give {0,0}
		// under LCS, so a {501,501} result proves the fallback fired instead.
		const big = Array.from({ length: 501 }, (_, i) => `line ${i}`).join("\n");
		expect(lineChurn(big, big)).toEqual({ added: 501, removed: 501 });
	});
});
