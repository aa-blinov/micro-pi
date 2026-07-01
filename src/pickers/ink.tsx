import { Box, render, Text, useInput } from "ink";
import { type JSX, useState } from "react";
import { gradientHex } from "../ui/gradient.ts";
import type { Pickers, PickOption, PickOptions } from "./types.ts";

/** Same cyan→violet palette as the banner/loader/border/chat labels. */
const TITLE_COLOR = gradientHex(0);
const SELECTED_COLOR = gradientHex(1);

export function ModalPicker<T>(props: {
	options: PickOption<T>[];
	opts?: PickOptions;
	onSelect: (value: T) => void;
	onCancel: () => void;
}): JSX.Element {
	const [idx, setIdx] = useState(props.opts?.defaultIndex ?? 0);
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
	const title = props.opts?.title;
	return (
		<Box flexDirection="column" padding={1}>
			{title && (
				<Text bold color={TITLE_COLOR}>
					{title}
				</Text>
			)}
			{props.options.map((o, i) => (
				<Box key={o.label} flexDirection="column">
					<Text>
						<Text color={i === idx ? SELECTED_COLOR : "gray"}>{i === idx ? ">" : " "}</Text>{" "}
						<Text color={i === idx ? SELECTED_COLOR : "white"} bold={i === idx}>
							{o.label}
						</Text>
					</Text>
					{i === idx && o.description && <Text color="gray"> {o.description}</Text>}
				</Box>
			))}
			<Box marginTop={1}>
				<Text color="gray">up/down select · Enter confirm · Esc cancel</Text>
			</Box>
		</Box>
	);
}

export function TextInputModal(props: {
	label: string;
	defaultValue?: string;
	placeholder?: string;
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
			<Text bold color={TITLE_COLOR}>
				{props.label}
			</Text>
			<Box>
				<Text color="gray">{"> "}</Text>
				<Text>{text}</Text>
				<Text color="white" inverse>
					{" "}
				</Text>
			</Box>
			{props.placeholder && !text && (
				<Box marginTop={1}>
					<Text color="gray">{props.placeholder}</Text>
				</Box>
			)}
			<Box marginTop={1}>
				<Text color="gray">Enter confirm · Esc cancel</Text>
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

	promptText(label: string, defaultValue?: string, placeholder?: string): Promise<string | null> {
		return new Promise((resolve) => {
			const instance = render(
				<TextInputModal
					label={label}
					defaultValue={defaultValue}
					placeholder={placeholder}
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
