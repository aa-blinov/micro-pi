import { describe, expect, it } from "vitest";
import {
	appendDateRolloverReminder,
	buildDateRolloverReminder,
	dateRolloverReminderBody,
	formatLocalDate,
	initialAnnouncedLocalDate,
} from "../src/core/date-rollover-reminder.ts";
import type { Message } from "../src/core/llm.ts";

describe("formatLocalDate", () => {
	it("formats as YYYY-MM-DD", () => {
		expect(formatLocalDate(new Date(2026, 6, 17))).toBe("2026-07-17");
	});
});

describe("dateRolloverReminderBody", () => {
	it("returns null when today equals or precedes last announced", () => {
		expect(dateRolloverReminderBody("2026-07-17", "2026-07-17")).toBeNull();
		expect(dateRolloverReminderBody("2026-07-16", "2026-07-17")).toBeNull();
	});

	it("returns a body when today is after last announced", () => {
		const body = dateRolloverReminderBody("2026-07-18", "2026-07-17");
		expect(body).toContain("2026-07-18");
		expect(body).toContain("calendar date has advanced");
	});
});

describe("buildDateRolloverReminder", () => {
	it("wraps in system-reminder tags", () => {
		const reminder = buildDateRolloverReminder("2026-07-18");
		expect(reminder.startsWith("<system-reminder>\n")).toBe(true);
		expect(reminder.endsWith("\n</system-reminder>")).toBe(true);
		expect(reminder).toContain("2026-07-18");
	});
});

describe("appendDateRolloverReminder", () => {
	it("inserts before the trailing user message and advances the announced date", () => {
		const messages: Message[] = [{ role: "user", content: "hi" }];
		const announced = { value: "2026-07-17" };
		expect(appendDateRolloverReminder(messages, announced, "2026-07-18")).toBe(true);
		expect(announced.value).toBe("2026-07-18");
		expect(messages).toHaveLength(2);
		expect(contentToText(messages[0]!.content)).toContain("calendar date has advanced");
		expect(messages[1]).toEqual({ role: "user", content: "hi" });
		expect(appendDateRolloverReminder(messages, announced, "2026-07-18")).toBe(false);
		expect(messages).toHaveLength(2);
	});
});

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	return "";
}

describe("initialAnnouncedLocalDate", () => {
	it("prefers the persisted field", () => {
		expect(
			initialAnnouncedLocalDate({ lastAnnouncedLocalDate: "2026-01-01", createdAt: "2026-07-17T12:00:00.000Z" }),
		).toBe("2026-01-01");
	});

	it("falls back to createdAt local date", () => {
		const created = new Date(2026, 6, 10, 15, 0, 0);
		expect(initialAnnouncedLocalDate({ createdAt: created.toISOString() })).toBe(formatLocalDate(created));
	});
});
