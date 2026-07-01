import { Box, Static, Text } from "ink";
import { type JSX, useMemo } from "react";
import { gradientHex } from "./gradient.ts";
import { Spinner } from "./Spinner.tsx";
import type { ChatMessage, RetryInfo, StreamingState, ToolCallEntry } from "./useAgentSession.ts";

interface ChatLogProps {
	messages: ChatMessage[];
	streaming: StreamingState | null;
	error: string | null;
	retry: RetryInfo | null;
}

const TOOL_COLOR = gradientHex(0);
// Sampled from the same cyan→violet brand gradient (t=0.3 lands on a clean
// sky blue) rather than raw ANSI "blue", which reads dark/muddy on a black
// background and doesn't relate to the rest of the palette.
const USER_COLOR = gradientHex(0.3);
// No point along the cyan→violet gradient can be green (neither endpoint has
// enough green channel to interpolate through it), so this is a standalone
// hex picked to match the gradient's brightness/saturation level instead —
// vivid and readable on black, not the muddier default ANSI "green".
const AGENT_COLOR = "#4ade80";

function ToolCallView({ call }: { call: ToolCallEntry }): JSX.Element {
	const statusColor = call.status === "running" ? "yellow" : call.status === "error" ? "red" : "green";
	const argsDisplay = useMemo(() => {
		try {
			const parsed = JSON.parse(call.args) as Record<string, unknown>;
			return Object.entries(parsed)
				.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
				.join(", ");
		} catch {
			return call.args.slice(0, 200);
		}
	}, [call.args]);
	return (
		<Box flexDirection="column">
			<Text>
				<Text color={TOOL_COLOR}>[{call.name}]</Text> <Text color={statusColor}>[{call.status}]</Text>{" "}
				<Text color="gray">{argsDisplay}</Text>
			</Text>
			{call.result && (
				<Text color={call.status === "error" ? "red" : "gray"} wrap="truncate">
					{call.result.slice(0, 500)}
					{call.result.length > 500 ? " ..." : ""}
				</Text>
			)}
		</Box>
	);
}

function MessageView({ message }: { message: ChatMessage }): JSX.Element {
	if (message.role === "user") {
		return (
			<Box flexDirection="column">
				<Text color={USER_COLOR}>
					<Text bold>[user] </Text>
					{message.content}
				</Text>
			</Box>
		);
	}
	if (message.role === "assistant") {
		return (
			<Box flexDirection="column">
				{message.content && (
					<Text color={AGENT_COLOR}>
						<Text bold>[agent] </Text>
						{message.content}
					</Text>
				)}
				{message.toolCalls &&
					message.toolCalls.length > 0 &&
					message.toolCalls.map((c) => <ToolCallView key={c.id} call={c} />)}
			</Box>
		);
	}
	if (message.role === "warning") {
		return (
			<Box>
				<Text color="red">[{message.content}]</Text>
			</Box>
		);
	}
	return (
		<Text>
			[{message.role}] {message.content}
		</Text>
	);
}

export function ChatLog({ messages, streaming, error, retry }: ChatLogProps): JSX.Element {
	const liveParts: JSX.Element[] = [];

	// Error/warning before streaming — chronologically the error happened
	// first (e.g. vision fallback), then the agent responded.
	if (error) {
		liveParts.push(
			<Text key="error" color="red">
				[{error}]
			</Text>,
		);
	}

	if (retry) {
		liveParts.push(
			<Text key="retry" color="yellow">
				[Retrying ({retry.attempt}/{retry.maxAttempts}): {retry.reason}]
			</Text>,
		);
	}

	if (streaming) {
		const streamingParts: JSX.Element[] = [];
		const hasOutput = streaming.thinking || streaming.content || streaming.toolCalls.length > 0;
		if (!hasOutput) {
			streamingParts.push(<Spinner key="wait" />);
		}
		if (streaming.thinking) {
			streamingParts.push(
				<Text key="t" color="gray" dimColor>
					{streaming.thinking}
				</Text>,
			);
		}
		if (streaming.content) {
			streamingParts.push(
				<Text key="c" color={AGENT_COLOR}>
					<Text bold>[agent] </Text>
					{streaming.content}
				</Text>,
			);
		}
		for (const tc of streaming.toolCalls) {
			streamingParts.push(<ToolCallView key={tc.id} call={tc} />);
		}
		liveParts.push(
			<Box key="streaming" flexDirection="column">
				{streamingParts}
			</Box>,
		);
	}

	return (
		<>
			<Static items={messages}>{(m, i) => <MessageView key={`m-${i}`} message={m} />}</Static>
			<Box flexDirection="column">{liveParts}</Box>
		</>
	);
}
