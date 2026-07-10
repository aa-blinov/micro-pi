import { Box, Static, Text } from "ink";
import { type JSX, useMemo } from "react";
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

/**
 * Line-level churn between two blocks of text. Uses an LCS so the counts
 * reflect the lines that actually changed, not the whole replaced block — a
 * one-line tweak inside a 6-line oldText/newText reads as "+1 -1", not "+6 -6".
 * Falls back to a block count for pathologically large edits so the O(m·n) DP
 * can't stall the render.
 */
export function lineChurn(oldText: string, newText: string): { added: number; removed: number } {
	const a = oldText.split("\n");
	const b = newText.split("\n");
	const m = a.length;
	const n = b.length;
	if (m * n > 250_000) return { removed: m, added: n };
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
		}
	}
	const lcs = dp[0]![0]!;
	return { removed: m - lcs, added: n - lcs };
}

/**
 * One-line summary for a tool call. edit/write get a readable file + change
 * summary instead of a truncated JSON blob; every other tool keeps the generic
 * `key=value` args. Args stream in as partial JSON, so anything that fails to
 * parse (or doesn't match the expected shape) falls back to the raw/generic
 * form — the rich view only kicks in once the call is complete.
 */
function ToolSummary({ name, args }: { name: string; args: string }): JSX.Element {
	return useMemo(() => {
		let parsed: Record<string, unknown> | null = null;
		try {
			parsed = JSON.parse(args) as Record<string, unknown>;
		} catch {
			parsed = null;
		}

		if (parsed && name === "edit" && typeof parsed.path === "string" && Array.isArray(parsed.edits)) {
			let added = 0;
			let removed = 0;
			for (const e of parsed.edits) {
				if (e && typeof e === "object" && typeof (e as { oldText?: unknown }).oldText === "string") {
					const churn = lineChurn(
						(e as { oldText: string }).oldText,
						String((e as { newText?: unknown }).newText ?? ""),
					);
					added += churn.added;
					removed += churn.removed;
				}
			}
			return (
				<Text wrap="truncate">
					<Text color={theme().muted}>{parsed.path} · </Text>
					<Text color={theme().success}>+{added}</Text>
					<Text color={theme().muted}> </Text>
					<Text color={theme().error}>-{removed}</Text>
				</Text>
			);
		}

		if (parsed && name === "read" && typeof parsed.path === "string") {
			const offset = typeof parsed.offset === "number" ? parsed.offset : 0;
			const limit = typeof parsed.limit === "number" ? parsed.limit : undefined;
			const range = limit ? `${offset + 1}-${offset + limit}` : "all";
			return (
				<Text color={theme().muted} wrap="truncate">
					{parsed.path} · lines {range}
				</Text>
			);
		}

		if (parsed && name === "write" && typeof parsed.path === "string") {
			const lines = typeof parsed.content === "string" ? parsed.content.split("\n").length : 0;
			return (
				<Text color={theme().muted} wrap="truncate">
					{parsed.path} · {lines} {lines === 1 ? "line" : "lines"}
				</Text>
			);
		}

		const generic = parsed
			? Object.entries(parsed)
					.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
					.join(", ")
			: args.slice(0, 200);
		return (
			<Text color={theme().muted} wrap="truncate">
				{generic}
			</Text>
		);
	}, [name, args]);
}

function ToolCallView({ call }: { call: ToolCallEntry }): JSX.Element {
	const statusColor =
		call.status === "running" ? theme().warning : call.status === "error" ? theme().error : theme().success;
	return (
		<Box flexDirection="column">
			<Text>
				<Text color={theme().tool}>[{call.name}]</Text> <Text color={statusColor}>[{call.status}]</Text>{" "}
				<ToolSummary name={call.name} args={call.args} />
			</Text>
			{call.result && call.name !== "read" && (
				<Text color={call.status === "error" ? theme().error : theme().muted} wrap="truncate">
					{call.result.slice(0, 500)}
					{call.result.length > 500 ? " ..." : ""}
				</Text>
			)}
		</Box>
	);
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
 */
export function clampStreamingBlocks(
	blocks: StreamBlock[],
	rows: number,
	columns: number,
): Array<{ block: StreamBlock; truncated: boolean }> {
	// Rows reserved for everything below the streaming area: composer frame
	// (3), status bar (1), notices/steer/queue lines and a safety margin.
	const budget = Math.max(4, rows - 8);
	const cols = Math.max(20, columns);

	const wrappedRows = (text: string, prefixLen: number): number => {
		let total = 0;
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const len = lines[i]!.length + (i === 0 ? prefixLen : 0);
			total += Math.max(1, Math.ceil(len / cols));
		}
		return total;
	};

	const out: Array<{ block: StreamBlock; truncated: boolean }> = [];
	let used = 0;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i]!;
		if (used >= budget) break;
		if (block.kind === "tool") {
			out.unshift({ block, truncated: false });
			used += 1;
			continue;
		}
		const prefixLen = block.kind === "thinking" ? "[reasoning] ".length : "[agent] ".length;
		const need = wrappedRows(block.text, prefixLen);
		if (used + need <= budget) {
			out.unshift({ block, truncated: false });
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
			tailRows += Math.max(1, Math.ceil(lines[j]!.length / cols));
		}
		// A single wrapped line longer than the budget: hard-cut by characters.
		let text = kept.join("\n");
		const maxChars = remaining * cols;
		if (kept.length === 1 && text.length > maxChars) text = text.slice(-maxChars);
		out.unshift({ block: { ...block, text }, truncated: true });
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
		clamped.forEach(({ block, truncated }, i) => {
			streamingParts.push(<BlockView key={blockKey(block, i)} block={block} truncated={truncated} />);
		});
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
