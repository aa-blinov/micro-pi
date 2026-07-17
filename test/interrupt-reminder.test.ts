import { describe, expect, it } from "vitest";
import {
	appendInterruptReminder,
	buildInterruptReminder,
	INTERRUPT_REMINDER_BODY,
	messagesEndWithInterruptReminder,
	trailingToolsSignalUserAbort,
} from "../src/core/interrupt-reminder.ts";
import type { Message } from "../src/core/llm.ts";

describe("buildInterruptReminder", () => {
	it("wraps the body in system-reminder tags", () => {
		const reminder = buildInterruptReminder();
		expect(reminder).toContain("<system-reminder>");
		expect(reminder).toContain("</system-reminder>");
		expect(reminder).toContain(INTERRUPT_REMINDER_BODY);
	});
});

describe("appendInterruptReminder", () => {
	it("appends once and is idempotent", () => {
		const messages: Message[] = [{ role: "user", content: "hi" }];
		expect(appendInterruptReminder(messages)).toBe(true);
		expect(messages).toHaveLength(2);
		expect(appendInterruptReminder(messages)).toBe(false);
		expect(messages).toHaveLength(2);
		expect(messagesEndWithInterruptReminder(messages)).toBe(true);
	});

	it("skips when trailing tool results already signal abort", () => {
		const messages: Message[] = [
			{ role: "assistant", content: null, tool_calls: [] },
			{ role: "tool", tool_call_id: "t1", content: "[ABORTED] Command was interrupted by user." },
		];
		expect(trailingToolsSignalUserAbort(messages)).toBe(true);
		expect(appendInterruptReminder(messages)).toBe(false);
		expect(messages).toHaveLength(2);
	});
});
