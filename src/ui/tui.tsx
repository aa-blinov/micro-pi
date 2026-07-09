import { Box, render, Text } from "ink";
import type { JSX } from "react";
import { CAST_BANNER } from "../core/help.ts";
import { closeMcpConnections } from "../core/mcp.ts";
import { saveSession } from "../core/session.ts";
import { type ParsedArgs, runStartup } from "../core/startup.ts";
import { setSuspendHook, suspendAndRun } from "../core/stdin-manager.ts";
import { inkPickers } from "../pickers/ink.tsx";
import type { Pickers } from "../pickers/types.ts";
import { App } from "./App.tsx";
import { gradientBanner } from "./gradient.ts";
import { saveClipboardImageToTempFile } from "./readClipboardImage.ts";
import { Spinner } from "./Spinner.tsx";
import { loadTheme } from "./themes/index.ts";

function StartupLoader({ text }: { text: string }): JSX.Element {
	return (
		<Box>
			<Spinner />
			<Text> {text}</Text>
		</Box>
	);
}

/**
 * TUI entry point. Thin wrapper over runStartup plus
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

	// Load the saved theme before any UI — the startup spinner reads gradient
	// endpoints from the active theme.
	loadTheme(args.settings.theme);

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

	// Repaint the banner with the current theme's gradient. Uses suspendAndRun
	// to temporarily pause Ink so raw stdout writes don't fight its managed frame.
	const bannerLines = CAST_BANNER.split("\n").length + 2; // +2 for version + blank
	const onRepaintBanner = async () => {
		await suspendAndRun(async () => {
			// Move cursor up past the banner lines and clear them
			process.stdout.write(`\x1b[${bannerLines}A\x1b[J`);
			process.stdout.write(`${gradientBanner(CAST_BANNER, args.version)}\n`);
		});
	};

	const { waitUntilExit } = render(
		<App
			result={result}
			version={args.version}
			initialPrompt={args.initialPrompt}
			onPasteImage={onPasteImage}
			onQuit={onQuit}
			onRepaintBanner={onRepaintBanner}
		/>,
	);

	// Wire up Ink's suspendTerminal so execBash can hand the terminal to
	// child processes that need interactive stdin (password prompts, etc.).
	// We need to access Ink's internal instances WeakMap, which is not
	// exported by the package. Use dynamic import with a file:// URL to
	// bypass the exports field while still sharing the module cache.
	try {
		const { createRequire } = await import("node:module");
		const { pathToFileURL } = await import("node:url");
		const inkEntry = createRequire(import.meta.url).resolve("ink");
		const instancesPath = inkEntry.replace(/index\.js$/, "instances.js");
		const mod = await import(pathToFileURL(instancesPath).href);
		const instances: WeakMap<NodeJS.WritableStream, { suspendTerminal: (cb: () => Promise<void>) => Promise<void> }> =
			mod.default;
		const inkInstance = instances.get(process.stdout);
		if (inkInstance) {
			setSuspendHook((cb) => inkInstance.suspendTerminal(cb));
		}
	} catch {
		// Not running in TUI mode or ink internals changed — no-op.
	}

	await waitUntilExit();
	saveSession(result.session);
	await closeMcpConnections(result.mcpResult.connections);
}
