import { describe, expect, it } from "vitest";
import { buildDisplayMessages, messageContentToText } from "../src/ui/useAgentSession.ts";

type Msgs = Parameters<typeof buildDisplayMessages>[0];
const build = (msgs: unknown[]) => buildDisplayMessages(msgs as Msgs);

describe("messageContentToText", () => {
	it("returns a plain string as-is", () => {
		expect(messageContentToText("hello")).toBe("hello");
	});

	it("joins the text parts of a structured (cache-control-rewritten) content array", () => {
		expect(
			messageContentToText([
				{ type: "text", text: "line 1" },
				{ type: "text", text: "line 2" },
			]),
		).toBe("line 1\nline 2");
	});

	it("summarizes image parts as [image] / [N images], after any text", () => {
		expect(messageContentToText([{ type: "image_url", image_url: { url: "x" } }])).toBe("[image]");
		expect(
			messageContentToText([
				{ type: "text", text: "look:" },
				{ type: "image_url", image_url: { url: "a" } },
				{ type: "image_url", image_url: { url: "b" } },
			]),
		).toBe("look:\n[2 images]");
	});

	it("falls back to a placeholder for content it can't extract", () => {
		expect(messageContentToText([{ type: "weird" }])).toBe("[structured content]");
		expect(messageContentToText(42)).toBe("[structured content]");
		expect(messageContentToText(null)).toBe("[structured content]");
	});
});

describe("buildDisplayMessages", () => {
	it("drops system and standalone tool messages, keeps user text", () => {
		const out = build([
			{ role: "system", content: "you are..." },
			{ role: "user", content: "hi" },
			{ role: "tool", tool_call_id: "orphan", content: "leftover" },
		]);
		expect(out).toEqual([{ role: "user", content: "hi" }]);
	});

	it("extracts text from a structured user message (image attachment)", () => {
		const out = build([
			{
				role: "user",
				content: [
					{ type: "text", text: "see this" },
					{ type: "image_url", image_url: { url: "x" } },
				],
			},
		]);
		expect(out).toEqual([{ role: "user", content: "see this\n[image]" }]);
	});

	it("renders an assistant text turn as a single content block", () => {
		const out = build([{ role: "assistant", content: "the answer" }]);
		expect(out).toEqual([{ role: "assistant", content: "", blocks: [{ kind: "content", text: "the answer" }] }]);
	});

	it("collapses an assistant tool-call turn plus its tool results into one message, associated by id", () => {
		const out = build([
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } },
					{ id: "c2", type: "function", function: { name: "bash", arguments: "{}" } },
				],
			},
			{ role: "tool", tool_call_id: "c2", content: "bash output" },
			{ role: "tool", tool_call_id: "c1", content: "file body" },
		]);
		expect(out).toEqual([
			{
				role: "assistant",
				content: "",
				blocks: [
					{
						kind: "tool",
						call: { id: "c1", name: "read", args: '{"path":"a"}', status: "ok", result: "file body" },
					},
					{ kind: "tool", call: { id: "c2", name: "bash", args: "{}", status: "ok", result: "bash output" } },
				],
			},
		]);
	});

	it("restores [error] status from castIsError on tool results", () => {
		const out = build([
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "e1", type: "function", function: { name: "bash", arguments: "{}" } }],
			},
			{
				role: "tool",
				tool_call_id: "e1",
				content: "Error: command failed",
				castIsError: true,
			},
		]);
		expect(out[0]!.blocks).toEqual([
			{
				kind: "tool",
				call: {
					id: "e1",
					name: "bash",
					args: "{}",
					status: "error",
					result: "Error: command failed",
				},
			},
		]);
	});

	it("keeps assistant text before its tool calls (content block first, then tools)", () => {
		const out = build([
			{
				role: "assistant",
				content: "let me check",
				tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: "{}" } }],
			},
			{ role: "tool", tool_call_id: "c1", content: "files" },
		]);
		expect(out[0]!.blocks).toEqual([
			{ kind: "content", text: "let me check" },
			{ kind: "tool", call: { id: "c1", name: "ls", args: "{}", status: "ok", result: "files" } },
		]);
	});

	it("truncates an over-long tool result to 4000 chars", () => {
		const out = build([
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
			},
			{ role: "tool", tool_call_id: "c1", content: "x".repeat(5000) },
		]);
		const block = out[0]!.blocks!.find((b) => b.kind === "tool");
		expect((block as { call: { result: string } }).call.result).toHaveLength(4000);
	});

	it("does not re-visit tool results as standalone messages after an assistant turn", () => {
		const out = build([
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
			},
			{ role: "tool", tool_call_id: "c1", content: "done" },
			{ role: "user", content: "next" },
		]);
		// user, assistant(+tool), user — the tool message must not appear on its own.
		expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
	});

	it("leaves blocks undefined for an empty assistant message (no content, no tools)", () => {
		const out = build([{ role: "assistant", content: null }]);
		expect(out).toEqual([{ role: "assistant", content: "", blocks: undefined }]);
	});
});
