import { describe, expect, it } from "vitest";
import { pickerViewportRows } from "../src/pickers/ink.tsx";

describe("pickerViewportRows", () => {
	it("uses the full 10-row window on a default 24-row terminal", () => {
		expect(pickerViewportRows(24)).toBe(10);
	});

	it("caps at 10 rows on tall terminals", () => {
		expect(pickerViewportRows(60)).toBe(10);
	});

	it("shrinks on short terminals so modal + composer still fit", () => {
		expect(pickerViewportRows(20)).toBe(7);
		expect(pickerViewportRows(17)).toBe(4);
	});

	it("never goes below 3 rows, even on tiny terminals", () => {
		expect(pickerViewportRows(12)).toBe(3);
		expect(pickerViewportRows(5)).toBe(3);
	});
});
