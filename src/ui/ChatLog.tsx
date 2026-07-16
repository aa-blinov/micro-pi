import { Box, Static, Text } from "ink";
import { type JSX, useMemo } from "react";
import { displayWidth } from "./display-width.ts";
import { Spinner } from "./Spinner.tsx";
import { theme } from "./themes/index.ts";
import type { ChatMessage, RetryInfo, StreamBlock, StreamingState, ToolCallEntry } from "./useAgentSession.ts";

interface ChatLogProps {
	messages: ChatMessage[];
	streaming: StreamingState | null;
	error: string | null;
	retry: RetryInfo | null;
	/**
	 * Bumped by App after a terminal resize settles. Used as the <Static> key so
	 * the whole history is replayed from a clean top — Ink otherwise only prints
	 * newly-added static items, so a resize-time screen clear would wipe the
	 * on-screen history with no way to redraw it. See App.tsx's resize effect.
	 */
	repaintKey?: number;
}

type ToolSummaryModel =
	| { kind: "edit"; path: string; added: number; removed: number }
	| { kind: "read"; path: string; range: string }
	| { kind: "write"; path: string; lines: number }
	| { kind: "generic"; text: string };

/**
 * Parse the leading line number out of a hashline anchor like
 * `42:abc123` or `42:abc123:1f2`. Returns null for garbage — the
 * caller already falls back to a generic summary in that case.
 */
function anchorLineOf(anchor: unknown): number | null {
	if (typeof anchor !== "string") return null;
	const m = /^(\d+):/.exec(anchor);
	if (!m) return null;
	return Number.parseInt(m[1]!, 10);
}

/**
 * Data half of the tool-call summary. edit/write get a readable file + change
 * summary instead of a truncated JSON blob; every other tool keeps the generic
 * `key=value` args. Args stream in as partial JSON, so anything that fails to
 * parse (or doesn't match the expected shape) falls back to the raw/generic
 * form — the rich view only kicks in once the call is complete.
 */
function parseToolSummary(name: string, args: string): ToolSummaryModel {
	let parsed: Record<string, unknown> | null = null;
	try {
		parsed = JSON.parse(args) as Record<string, unknown>;
	} catch {
		parsed = null;
	}

	if (parsed && name === "edit" && typeof parsed.path === "string" && Array.isArray(parsed.ops)) {
		let added = 0;
		let removed = 0;
		for (const op of parsed.ops) {
			if (!op || typeof op !== "object") continue;
			const o = op as Record<string, unknown>;
			if (o.op === "write") continue;
			const content = typeof o.content === "string" ? o.content : "";
			if (o.op === "insert_after") {
				added += content.split("\n").length;
			} else if (o.op === "replace") {
				// Approximate line churn from the anchor range. The model
				// only sends anchors, not the original line text, so we
				// can't run `lineChurn` here without re-reading the file.
				// This is UI-only — the underlying tool is exact.
				const startLine = anchorLineOf(o.anchor);
				const endLine = o.end_anchor ? anchorLineOf(o.end_anchor) : startLine;
				if (startLine && endLine) {
					removed += Math.abs(endLine - startLine) + 1;
				}
				added += content.split("\n").length;
			}
		}
		return { kind: "edit", path: parsed.path, added, removed };
	}

	if (parsed && name === "read" && typeof parsed.path === "string") {
		const offset = typeof parsed.offset === "number" ? parsed.offset : 0;
		const limit = typeof parsed.limit === "number" ? parsed.limit : undefined;
		const range = limit ? `${offset + 1}-${offset + limit}` : "all";
		return { kind: "read", path: parsed.path, range };
	}

	if (parsed && name === "write" && typeof parsed.path === "string") {
		const lines = typeof parsed.content === "string" ? parsed.content.split("\n").length : 0;
		return { kind: "write", path: parsed.path, lines };
	}

	const generic = parsed
		? Object.entries(parsed)
				.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
				.join(", ")
		: args.slice(0, 200);
	return { kind: "generic", text: generic };
}

/**
 * One-line summary for a tool call. Only the parse is memoized — the JSX is
 * rebuilt every render so theme() colors stay live: memoizing the whole
 * element on [name, args] kept the previous theme's colors on still-visible
 * rows after a /theme switch.
 */
function ToolSummary({ name, args }: { name: string; args: string }): JSX.Element {
	const model = useMemo(() => parseToolSummary(name, args), [name, args]);
	if (model.kind === "edit") {
		return (
			<Text wrap="truncate">
				<Text color={theme().muted}>{model.path} · </Text>
				<Text color={theme().success}>+{model.added}</Text>
				<Text color={theme().muted}> </Text>
				<Text color={theme().error}>-{model.removed}</Text>
			</Text>
		);
	}
	if (model.kind === "read") {
		return (
			<Text color={theme().muted} wrap="truncate">
				{model.path} · lines {model.range}
			</Text>
		);
	}
	if (model.kind === "write") {
		return (
			<Text color={theme().muted} wrap="truncate">
				{model.path} · {model.lines} {model.lines === 1 ? "line" : "lines"}
			</Text>
		);
	}
	return (
		<Text color={theme().muted} wrap="truncate">
			{model.text}
		</Text>
	);
}

function ToolCallView({ call }: { call: ToolCallEntry }): JSX.Element {
	const statusColor =
		call.status === "running" ? theme().warning : call.status === "error" ? theme().error : theme().success;
	return (
		<Box flexDirection="column">
			<Text>
				<Text color={theme().tool}>[{call.name}]</Text> <Text color={statusColor}>[{call.status}]</Text>{" "}
				<ToolSummary name={call.name} args={call.args} />
				{call.result && <WebResultSummary name={call.name} result={call.result} />}
			</Text>
			{call.result && call.name !== "read" && !isWebTool(call.name) && (
				<Text color={call.status === "error" ? theme().error : theme().muted} wrap="truncate">
					{call.result.slice(0, 500)}
					{call.result.length > 500 ? " ..." : ""}
				</Text>
			)}
		</Box>
	);
}

function isWebTool(name: string): boolean {
	return name === "web_search" || name === "web_fetch";
}

function WebResultSummary({ name, result }: { name: string; result: string }): JSX.Element | null {
	if (name === "web_search") {
		const meta = /^<!--(\{.*?})-->/.exec(result);
		if (meta) {
			try {
				const { count } = JSON.parse(meta[1]) as { count: number };
				return (
					<Text color={theme().muted}>
						{" · "}
						{count} result{count !== 1 ? "s" : ""}
					</Text>
				);
			} catch {
				// malformed — fall through
			}
		}
		return (
			<Text color={theme().muted}>
				{" · "}
				{result.startsWith("No results") ? 0 : result.split("\n\n").length} results
			</Text>
		);
	}
	if (name === "web_fetch") {
		return (
			<Text color={theme().muted}>
				{" · "}
				{result.length.toLocaleString()} chars
			</Text>
		);
	}
	return null;
}

/**
 * Renders one ordered block. Shared between live streaming and committed
 * history so a turn reads identically before and after it lands — the reason
 * StreamBlock is the single source of truth for row order.
 */
function BlockView({ block, truncated }: { block: StreamBlock; truncated?: boolean }): JSX.Element {
	if (block.kind === "thinking") {
		return (
			<Text color={theme().muted} dimColor>
				<Text bold>[reasoning] {truncated ? "… " : ""}</Text>
				{block.text}
			</Text>
		);
	}
	if (block.kind === "content") {
		return (
			<Text color={theme().agent}>
				<Text bold>[agent] {truncated ? "… " : ""}</Text>
				{block.text}
			</Text>
		);
	}
	return <ToolCallView call={block.call} />;
}

/**
 * Clamp the live streaming blocks to fit the terminal viewport, keeping the
 * tail. Ink's log-update redraws the live region by moving the cursor up N
 * rows and erasing — but the cursor can't move above the top of the screen,
 * so a live region taller than the viewport can't be fully erased and every
 * redraw stacks a duplicate frame into scrollback (repeated [reasoning] /
 * [agent] lines). Settled blocks already drain into <Static> (see
 * useAgentSession), but a single still-streaming block can grow past the
 * viewport on its own; here we render only its last lines that fit. The full
 * text still lands in history when the block settles — only the live preview
 * is clipped.
 *
 * Each entry carries the block's index in the *input* array so React keys
 * stay aligned with the unclamped list — keying by position in the clamped
 * output shifted identities whenever older blocks dropped out of the window.
 */
export function clampStreamingBlocks(
	blocks: StreamBlock[],
	rows: number,
	columns: number,
): Array<{ block: StreamBlock; truncated: boolean; index: number }> {
	// Rows reserved for everything below the streaming area: composer frame
	// (3), status bar (1), notices/steer/queue lines and a safety margin.
	const budget = Math.max(4, rows - 8);
	const cols = Math.max(20, columns);

	const wrappedRows = (text: string, prefixLen: number): number => {
		let total = 0;
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const len = displayWidth(lines[i]!) + (i === 0 ? prefixLen : 0);
			total += Math.max(1, Math.ceil(len / cols));
		}
		return total;
	};

	const out: Array<{ block: StreamBlock; truncated: boolean; index: number }> = [];
	let used = 0;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i]!;
		if (used >= budget) break;
		if (block.kind === "tool") {
			out.unshift({ block, truncated: false, index: i });
			used += 1;
			continue;
		}
		const prefixLen = block.kind === "thinking" ? "[reasoning] ".length : "[agent] ".length;
		const need = wrappedRows(block.text, prefixLen);
		if (used + need <= budget) {
			out.unshift({ block, truncated: false, index: i });
			used += need;
			continue;
		}
		// Keep only the tail lines of this block that fit the remaining budget.
		const remaining = budget - used;
		const lines = block.text.split("\n");
		const kept: string[] = [];
		let tailRows = 0;
		for (let j = lines.length - 1; j >= 0 && tailRows < remaining; j--) {
			kept.unshift(lines[j]!);
			tailRows += Math.max(1, Math.ceil(displayWidth(lines[j]!) / cols));
		}
		// A single wrapped line longer than the budget: hard-cut by characters.
		// maxChars is measured in cells, so with wide chars this cuts slightly
		// more than strictly necessary — erring short is the safe direction.
		let text = kept.join("\n");
		const maxChars = remaining * cols;
		if (kept.length === 1 && text.length > maxChars) text = text.slice(-maxChars);
		out.unshift({ block: { ...block, text }, truncated: true, index: i });
		used = budget;
		break;
	}
	return out;
}

/**
 * Stable-ish key for a block at a given index. Tool blocks have a real id;
 * text/reasoning runs are positionally stable (blocks only append or update
 * in place, never reorder or change kind at an index), so index suffices.
 */
function blockKey(block: StreamBlock, index: number): string {
	return block.kind === "tool" ? `tool-${block.call.id}` : `${block.kind}-${index}`;
}

function MessageView({ message }: { message: ChatMessage }): JSX.Element {
	if (message.role === "user") {
		return (
			<Box flexDirection="column">
				<Text color={theme().user}>
					<Text bold>[user] </Text>
					{message.content}
				</Text>
			</Box>
		);
	}
	if (message.role === "assistant") {
		return (
			<Box flexDirection="column">
				{message.blocks?.map((b, i) => (
					<BlockView key={blockKey(b, i)} block={b} />
				))}
			</Box>
		);
	}
	if (message.role === "warning") {
		return (
			<Box>
				<Text color={theme().warning}>{message.content}</Text>
			</Box>
		);
	}
	return (
		<Text>
			[{message.role}] {message.content}
		</Text>
	);
}

export function ChatLog({ messages, streaming, error, retry, repaintKey }: ChatLogProps): JSX.Element {
	const liveParts: JSX.Element[] = [];

	// Error/warning before streaming — chronologically the error happened
	// first (e.g. vision fallback), then the agent responded.
	if (error) {
		liveParts.push(
			<Text key="error" color={theme().error}>
				[{error}]
			</Text>,
		);
	}

	if (retry) {
		liveParts.push(
			<Text key="retry" color={theme().warning}>
				[Retrying ({retry.attempt}/{retry.maxAttempts}): {retry.reason}]
			</Text>,
		);
	}

	if (streaming) {
		const streamingParts: JSX.Element[] = [];
		if (streaming.blocks.length === 0) {
			streamingParts.push(<Spinner key="wait" />);
		}
		const clamped = clampStreamingBlocks(streaming.blocks, process.stdout.rows || 24, process.stdout.columns || 80);
		for (const { block, truncated, index } of clamped) {
			streamingParts.push(<BlockView key={blockKey(block, index)} block={block} truncated={truncated} />);
		}
		liveParts.push(
			<Box key="streaming" flexDirection="column">
				{streamingParts}
			</Box>,
		);
	}

	return (
		<>
			<Static key={repaintKey} items={messages}>
				{(m, i) => <MessageView key={`m-${i}`} message={m} />}
			</Static>
			<Box flexDirection="column">{liveParts}</Box>
		</>
	);
}
