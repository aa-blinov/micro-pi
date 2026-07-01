import { Box, render, Text } from "ink";
import type { JSX } from "react";
import { CAST_BANNER } from "../core/help.ts";
import { closeMcpConnections } from "../core/mcp.ts";
import { saveSession } from "../core/session.ts";
import { type ParsedArgs, runStartup } from "../core/startup.ts";
import { inkPickers } from "../pickers/ink.tsx";
import type { Pickers } from "../pickers/types.ts";
import { App } from "./App.tsx";
import { gradientBanner } from "./gradient.ts";
import { saveClipboardImageToTempFile } from "./readClipboardImage.ts";
import { Spinner } from "./Spinner.tsx";

function StartupLoader({ text }: { text: string }): JSX.Element {
	return (
		<Box>
			<Spinner />
			<Text> {text}</Text>
		</Box>
	);
}

/**
 * TUI entry point. Thin wrapper over runStartup (shared with --basic) plus
 * mounting the Ink App. Onboarding picker calls happen before render() so
 * they don't fight the long-lived App for stdin — see pickers/ink.tsx.
 *
 * runStartup can take a few seconds on the fast path too (silent model
 * re-check, MCP server handshakes) — with nothing mounted yet, that's a
 * blank terminal with no sign anything is happening. Mount a tiny spinner
 * instance first, feed it runStartup's progress text via rerender(), then
 * swap to the real App once it resolves.
 */
export async function runTui(args: ParsedArgs): Promise<void> {
	let loader: ReturnType<typeof render> | null = null;
	const showLoader = (text: string) => {
		if (loader) loader.rerender(<StartupLoader text={text} />);
		else loader = render(<StartupLoader text={text} />);
	};
	const hideLoader = () => {
		// unmount() alone leaves the last drawn frame sitting on screen — Ink's
		// own log-update only erases previous output on the *next* render, and
		// there isn't one once this instance is gone. clear() actively erases
		// those lines (see ink.js/log-update.js); has to run first.
		loader?.clear();
		loader?.unmount();
		loader = null;
	};

	// inkPickers renders its own onboarding UI via a fresh render() call per
	// prompt — mounting two Ink instances against the same stdout at once is
	// unsupported (Ink just warns and reuses one, and unmount() on either
	// then tears down both — see pickerBridge.ts for the same problem
	// post-mount). Hide the loader right before any picker shows; the next
	// onProgress call remounts it once runStartup moves past the prompt.
	const pickersWithLoaderHandoff: Pickers = {
		...inkPickers,
		pickOption: (options, opts) => {
			hideLoader();
			return inkPickers.pickOption(options, opts);
		},
		promptText: (label, defaultValue, placeholder) => {
			hideLoader();
			return inkPickers.promptText(label, defaultValue, placeholder);
		},
	};

	showLoader("Starting cast...");
	const result = await runStartup(args, pickersWithLoaderHandoff, showLoader);
	hideLoader();

	console.log(gradientBanner(CAST_BANNER, args.version));

	const onQuit = () => {
		saveSession(result.session);
		void closeMcpConnections(result.mcpResult.connections).finally(() => process.exit(0));
	};

	const onPasteImage = async (): Promise<string | null> => {
		const filePath = await saveClipboardImageToTempFile();
		return filePath;
	};

	const { waitUntilExit } = render(
		<App
			result={result}
			version={args.version}
			initialPrompt={args.initialPrompt}
			onPasteImage={onPasteImage}
			onQuit={onQuit}
		/>,
	);

	await waitUntilExit();
	saveSession(result.session);
	await closeMcpConnections(result.mcpResult.connections);
}
