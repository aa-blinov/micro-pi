/**
 * One-shot date-rollover reminder: when a session crosses local midnight,
 * inject a `<system-reminder>` so the model notices the calendar day changed.
 */

import type { Message } from "./llm.ts";

/** Format a Date as local `YYYY-MM-DD`. */
export function formatLocalDate(d: Date = new Date()): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/**
 * Pure decision: reminder body when `today` is strictly after `lastAnnounced`,
 * otherwise `null`. No inject when the clock moved backwards.
 */
export function dateRolloverReminderBody(today: string, lastAnnounced: string): string | null {
	if (today <= lastAnnounced) return null;
	return (
		`The local calendar date has advanced. Today's date is now ${today}. ` +
		`Use ${today} as the current date for this session.`
	);
}

/** `<system-reminder>` wrapper for a rollover notice about `today`. */
export function buildDateRolloverReminder(today: string): string {
	const body =
		`The local calendar date has advanced. Today's date is now ${today}. ` +
		`Use ${today} as the current date for this session.`;
	return `<system-reminder>\n${body}\n</system-reminder>`;
}

/** Mutable holder so the loop can update the session-backed date in place. */
export interface AnnouncedLocalDate {
	value: string;
}

/**
 * If today is after `announced.value`, inject a reminder and advance the marker.
 * When the transcript already ends with the new user turn, insert *before* it
 * so the model sees the rollover notice then the user message (submit path).
 * Returns true when a message was pushed.
 */
export function appendDateRolloverReminder(
	messages: Message[],
	announced: AnnouncedLocalDate,
	today: string = formatLocalDate(),
): boolean {
	const body = dateRolloverReminderBody(today, announced.value);
	if (!body) return false;
	const msg: Message = { role: "user", content: buildDateRolloverReminder(today) };
	const last = messages[messages.length - 1];
	if (last?.role === "user") {
		messages.splice(messages.length - 1, 0, msg);
	} else {
		messages.push(msg);
	}
	announced.value = today;
	return true;
}

/**
 * Initial announced date for a session: persisted field, else the local date
 * of `createdAt` (so overnight resume can still fire), else today.
 */
export function initialAnnouncedLocalDate(session: { lastAnnouncedLocalDate?: string; createdAt?: string }): string {
	if (session.lastAnnouncedLocalDate) return session.lastAnnouncedLocalDate;
	if (session.createdAt) {
		const created = new Date(session.createdAt);
		if (!Number.isNaN(created.getTime())) return formatLocalDate(created);
	}
	return formatLocalDate();
}
