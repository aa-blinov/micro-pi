/**
 * Web server entry point. Exported so src/index.ts can call it directly in
 * foreground mode (no child-process spawn needed). The standalone `main()`
 * at the bottom is only used when this file runs as a child process (daemon).
 */

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { loadSettings, updateSettings } from "../core/settings.ts";
import type { ParsedArgs } from "../core/startup.ts";
import { runStartup } from "../core/startup.ts";
import type { Pickers, PickOption } from "../pickers/types.ts";
import { createWebBridge } from "./bridge.ts";
import { clearWebState, writeWebState } from "./daemon-state.ts";
import { startWebServer } from "./server.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const VERSION: string = process.env.CAST_VERSION ?? "0.0.0";

export async function runWebServerMain(
	args: string[],
	options: { foreground: boolean; version?: string },
): Promise<void> {
	const ver = options.version ?? VERSION;
	// Parse --port / --host
	let port = parseInt(process.env.CAST_WEB_PORT ?? "1337", 10);
	let host = process.env.CAST_WEB_HOST ?? "127.0.0.1";
	// Set by the CLI launcher (src/index.ts), not passed as a CLI arg — the
	// launcher already strips --foreground out of the args it forwards, since
	// that flag only controls *how it spawns*, not anything the server itself
	// does — except which lifecycle it reports in the state file.
	const foreground = options.foreground;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--port" && args[i + 1]) {
			port = parseInt(args[i + 1]!, 10);
			i++;
		} else if (args[i] === "--host" && args[i + 1]) {
			host = args[i + 1]!;
			i++;
		} else if (args[i] === "--public") {
			host = "0.0.0.0";
		}
	}

	const settings = loadSettings();
	const cwd = process.env.CAST_CWD ? (await import("node:path")).resolve(process.env.CAST_CWD) : homedir();

	// Non-interactive pickers for web mode
	const webPickers: Pickers = {
		pickOption: async <T>(options: PickOption<T>[]): Promise<T | null> => {
			// Auto-select first non-muted option
			const first = options.find((o) => !o.muted);
			return first?.value ?? options[0]?.value ?? null;
		},
		promptText: async (_label: string, defaultValue?: string): Promise<string | null> => defaultValue ?? null,
		pickMulti: async <T>(options: PickOption<T>[]): Promise<T[] | null> => options.map((o) => o.value),
		log: (text: string) => console.log(text),
	};

	// Parse CLI model/persona/reasoning
	let cliModel: string | undefined;
	let cliPersona: string | undefined;
	let cliReasoning: string | undefined;
	let cliBypassPermissions = false;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--model" || args[i] === "-m") {
			cliModel = args[i + 1];
			i++;
		} else if (args[i] === "--persona" || args[i] === "-p") {
			cliPersona = args[i + 1];
			i++;
		} else if (args[i] === "--reasoning" || args[i] === "-r") {
			cliReasoning = args[i + 1];
			i++;
		} else if (args[i] === "--bypass-permissions") {
			cliBypassPermissions = true;
		}
	}

	const parsedArgs: ParsedArgs = {
		cwd,
		settings,
		cliModel,
		cliReasoning,
		cliPersona,
		initialPrompt: undefined,
		resumeRequested: false,
		resumePicker: false,
		cliBypassPermissions,
		noSkills: false,
		cliSkillPaths: [],
		noMcp: false,
		cliMcpPaths: [],
		version: ver,
	};

	// Auth: ensure password exists in settings
	const currentSettings = loadSettings();
	let webPassword = currentSettings.webPassword;
	if (!webPassword) {
		webPassword = randomBytes(18).toString("base64url");
		updateSettings({ webPassword });
		console.log("[cast web] first run — password generated and saved to ~/.cast/settings.json");
	}

	console.log("[cast web] starting up...");

	// Write state file IMMEDIATELY so the launcher's waitForStartup sees the
	// PID right away — runStartup (MCP, model probe) can take 10+ seconds
	// and the launcher would time out if we waited for listening.
	writeWebState({ pid: process.pid, port, host, startedAt: new Date().toISOString(), foreground });

	const result = await runStartup(parsedArgs, webPickers);
	console.log(`[cast web] persona: ${result.persona.label}, model: ${result.session.model}`);
	console.log("[cast web] ────────────────────────────────────");
	console.log(`[cast web]   login:    cast`);
	console.log(`[cast web]   password: ${webPassword}`);
	console.log("[cast web] ────────────────────────────────────");

	const bridge = createWebBridge(result);
	bridge.createSession();

	if (!LOOPBACK_HOSTS.has(host)) {
		console.log(
			`[cast web] ⚠ binding ${host} — reachable from other machines on this network, protected only by the password above.`,
		);
	}

	const server = startWebServer({
		port,
		host,
		bridge,
		webUser: "cast",
		webPassword,
		version: ver,
		onListening: () => {
			writeWebState({ pid: process.pid, port, host, startedAt: new Date().toISOString(), foreground });
			console.log(`[cast web] stop: cast web stop`);
		},
		onError: (err) => {
			if (err.code === "EADDRINUSE") {
				console.error(`[cast web] port ${port} is already in use on ${host}.`);
				console.error(
					`[cast web] run 'cast web status' to check what's running, or pick a different port with --port.`,
				);
			} else {
				console.error("[cast web] failed to start:", err.message);
			}
			process.exit(1);
		},
	});

	// Graceful shutdown — closing every live session drains their background
	// bash tasks and marks in-flight runs aborted before the process actually
	// exits, instead of Node's default "just die" behavior on SIGTERM/SIGINT.
	// SIGKILL (a hard `kill -9`, an OOM kill) can't be caught by anything —
	// that's exactly why start/stop/status all treat a dead recorded PID as
	// stale and self-heal, rather than assuming this handler always runs.
	let shuttingDown = false;
	const shutdown = (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`[cast web] received ${signal}, shutting down...`);
		for (const s of bridge.listSessions()) bridge.closeSession(s.id);
		clearWebState();
		server.close(() => process.exit(0));
		// server.close() waits for existing connections (including open SSE
		// streams) to end on their own — force exit if that takes too long
		// rather than hanging a `cast web stop` caller indefinitely.
		setTimeout(() => process.exit(0), 3000).unref();
	};
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}

async function main(): Promise<void> {
	await runWebServerMain(process.argv.slice(2), { foreground: process.env.CAST_WEB_FOREGROUND === "1" });
}

// Auto-run only when this file is the entry point (daemon spawn). The parent
// sets CAST_WEB_SKIP_AUTORUN=1 before importing for inline foreground mode.
if (!process.env.CAST_WEB_SKIP_AUTORUN) {
	main().catch((err) => {
		console.error("[cast web] fatal:", err);
		clearWebState();
		process.exit(1);
	});
}
