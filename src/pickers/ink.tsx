import { Box, render, Text, useInput } from "ink";
import { type JSX, useRef, useState } from "react";
import { theme } from "../ui/themes/index.ts";
import type { Pickers, PickOption, PickOptions } from "./types.ts";

// Max option rows rendered at once. Without a window a long list (models,
// sessions, themes) grows the live region past the terminal height, where
// Ink's log-update erase math breaks and every redraw stacks a duplicate
// frame — the same failure mode ChatLog's clampStreamingBlocks guards against.
const PICKER_ROWS = 10;

export function ModalPicker<T>(props: {
	options: PickOption<T>[];
	opts?: PickOptions;
	onSelect: (value: T) => void;
	onCancel: () => void;
}): JSX.Element {
	// defaultIndex may come from a findIndex miss (-1) — clamp so Enter can't
	// dereference options[-1].
	const [idx, setIdx] = useState(() =>
		Math.min(Math.max(0, props.opts?.defaultIndex ?? 0), Math.max(0, props.options.length - 1)),
	);
	useInput((input, key) => {
		if (key.upArrow) {
			setIdx((i) => (i - 1 + props.options.length) % props.options.length);
			return;
		}
		if (key.downArrow) {
			setIdx((i) => (i + 1) % props.options.length);
			return;
		}
		if (key.return) {
			props.onSelect(props.options[idx]!.value);
			return;
		}
		if (key.escape || input === "q") {
			props.onCancel();
		}
	});
	// Scroll the window to keep the selection visible (same pattern as the
	// composer's command palette).
	const scrollRef = useRef(0);
	const maxScroll = Math.max(0, props.options.length - PICKER_ROWS);
	if (scrollRef.current > maxScroll) scrollRef.current = maxScroll;
	if (idx < scrollRef.current) scrollRef.current = idx;
	else if (idx >= scrollRef.current + PICKER_ROWS) scrollRef.current = idx - PICKER_ROWS + 1;
	const scroll = scrollRef.current;
	const visible = props.options.slice(scroll, scroll + PICKER_ROWS);
	const title = props.opts?.title;
	const error = props.opts?.error;
	return (
		<Box flexDirection="column" padding={1}>
			{error && (
				<Box marginBottom={1}>
					<Text color={theme().error}>{error}</Text>
				</Box>
			)}
			{title && (
				<Text bold color={theme().accent}>
					{title}
				</Text>
			)}
			{visible.map((o, vi) => {
				const i = scroll + vi;
				const selected = i === idx;
				return (
					// Keyed by absolute index: options are static for the modal's
					// lifetime, and labels can repeat.
					<Box key={i} flexDirection="column">
						<Text>
							<Text color={selected ? theme().accent : theme().muted}>{selected ? ">" : " "}</Text>{" "}
							<Text color={selected ? theme().accent : "white"} bold={selected}>
								{o.label}
							</Text>
						</Text>
						{selected && o.description && <Text color={theme().muted}> {o.description}</Text>}
					</Box>
				);
			})}
			<Box marginTop={1}>
				<Text color={theme().muted}>
					up/down select · Enter confirm · Esc cancel
					{props.options.length > PICKER_ROWS ? ` · ${idx + 1}/${props.options.length}` : ""}
				</Text>
			</Box>
		</Box>
	);
}

export function TextInputModal(props: {
	label: string;
	defaultValue?: string;
	placeholder?: string;
	error?: string;
	onSubmit: (value: string) => void;
	onCancel: () => void;
}): JSX.Element {
	const [text, setText] = useState(props.defaultValue ?? "");
	useInput((input, key) => {
		if (key.return) {
			props.onSubmit(text);
			return;
		}
		if (key.escape) {
			props.onCancel();
			return;
		}
		if (key.backspace || key.delete) {
			setText((t) => t.slice(0, -1));
			return;
		}
		if (input && !key.ctrl && !key.meta) {
			// Accept multi-char paste (Cmd+V / Ctrl+V): terminals deliver
			// clipboard contents as one string. Strip control characters
			// and whitespace that bracketed-paste wrappers may add.
			const printable = [...input].filter((c) => c >= " " && c !== String.fromCodePoint(0x7f)).join("");
			if (printable) setText((t) => t + printable);
		}
	});
	return (
		<Box flexDirection="column" padding={1}>
			{props.error && (
				<Box marginBottom={1}>
					<Text color={theme().error}>{props.error}</Text>
				</Box>
			)}
			<Text bold color={theme().accent}>
				{props.label}
			</Text>
			<Box>
				<Text color={theme().muted}>{"> "}</Text>
				<Text>{text}</Text>
				<Text color="white" inverse>
					{" "}
				</Text>
			</Box>
			{props.placeholder && !text && (
				<Box marginTop={1}>
					<Text color={theme().muted}>{props.placeholder}</Text>
				</Box>
			)}
			<Box marginTop={1}>
				<Text color={theme().muted}>Enter confirm · Esc cancel</Text>
			</Box>
		</Box>
	);
}

/**
 * Standalone Ink-backed Pickers implementation. Each call spins up its own
 * short-lived Ink instance (render → wait for selection → unmount).
 *
 * Only safe to use *before* the main App is mounted (i.e. during
 * runStartup's onboarding, per tui.tsx) — once the long-lived App is
 * rendering, use the bridged pickers from ui/pickerBridge.ts instead, which
 * render the same ModalPicker/TextInputModal inside the existing Ink tree
 * instead of racing it for stdin/raw-mode with a second render() call.
 */
export const inkPickers: Pickers = {
	pickOption<T>(options: PickOption<T>[], opts?: PickOptions): Promise<T | null> {
		if (options.length === 0) return Promise.resolve(null);
		return new Promise((resolve) => {
			const instance = render(
				<ModalPicker
					options={options}
					opts={opts}
					onSelect={(v) => {
						resolve(v);
						instance.unmount();
					}}
					onCancel={() => {
						resolve(null);
						instance.unmount();
					}}
				/>,
			);
		});
	},

	promptText(label: string, defaultValue?: string, placeholder?: string, error?: string): Promise<string | null> {
		return new Promise((resolve) => {
			const instance = render(
				<TextInputModal
					label={label}
					defaultValue={defaultValue}
					placeholder={placeholder}
					error={error}
					onSubmit={(v) => {
						resolve(v);
						instance.unmount();
					}}
					onCancel={() => {
						resolve(null);
						instance.unmount();
					}}
				/>,
			);
		});
	},

	log(text: string): void {
		console.log(text);
	},
};
