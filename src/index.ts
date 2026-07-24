import { spawn } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { printHelp } from "./core/help.ts";
import { runNonInteractive } from "./core/run.ts";
import { loadSettings } from "./core/settings.ts";
import type { ParsedArgs } from "./core/startup.ts";
import { runUpgrade } from "./core/upgrade.ts";
import { runTui } from "./ui/tui.tsx";
import { clearWebState, isProcessAlive, readLiveWebState, readWebState } from "./web/daemon-state.ts";

const VERSION: string = JSON.parse(
	readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"),
).version;

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	if (args[0] === "upgrade") {
		const rest = args.slice(1);
		const force = rest.includes("--force");
		const pinnedVersion = rest.find((a) => a !== "--force");
		await runUpgrade(VERSION, pinnedVersion, force);
		return;
	}

	if (args[0] === "run") {
		await handleRunCommand(args.slice(1), VERSION);
		return;
	}

	if (args[0] === "web") {
		await handleWebCommand(args.slice(1));
		return;
	}

	const cwd = process.env.CAST_CWD ? resolve(process.env.CAST_CWD) : resolve(".");

	let cliModel: string | undefined;
	let cliReasoning: string | undefined;
	let cliPersona: string | undefined;
	let initialPrompt: string | undefined;
	let resumeRequested = false;
	let resumeId: string | undefined;
	let resumePicker = false;
	let cliBypassPermissions = false;
	let noSkills = false;
	const cliSkillPaths: string[] = [];
	let noMcp = false;
	const cliMcpPaths: string[] = [];

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--model" || args[i] === "-m") {
			cliModel = args[i + 1];
			i++;
		} else if (args[i] === "--reasoning" || args[i] === "-r") {
			cliReasoning = args[i + 1];
			i++;
		} else if (args[i] === "--persona" || args[i] === "-p") {
			cliPersona = args[i + 1];
			i++;
		} else if (args[i] === "--continue" || args[i] === "-c") {
			resumeRequested = true;
		} else if (args[i] === "--resume") {
			resumeRequested = true;
			resumePicker = true;
		} else if (args[i]?.startsWith("--resume=")) {
			resumeRequested = true;
			resumeId = args[i]!.slice("--resume=".length);
		} else if (args[i] === "--session" || args[i] === "-s") {
			resumeRequested = true;
			resumeId = args[i + 1];
			i++;
		} else if (args[i] === "--bypass-permissions") {
			cliBypassPermissions = true;
		} else if (args[i] === "--skill") {
			const path = args[i + 1];
			if (path) cliSkillPaths.push(path);
			i++;
		} else if (args[i] === "--no-skills") {
			noSkills = true;
		} else if (args[i] === "--mcp") {
			const path = args[i + 1];
			if (path) cliMcpPaths.push(path);
			i++;
		} else if (args[i] === "--no-mcp") {
			noMcp = true;
		} else if (args[i] === "--help" || args[i] === "-h") {
			printHelp();
			return;
		} else if (args[i] === "--version" || args[i] === "-v") {
			console.log(`cast v${VERSION}`);
			return;
		} else {
			initialPrompt = args.slice(i).join(" ");
			break;
		}
	}

	const settings = loadSettings();

	const parsedArgs: ParsedArgs = {
		cwd,
		settings,
		cliModel,
		cliReasoning,
		cliPersona,
		initialPrompt,
		resumeRequested,
		resumeId,
		resumePicker,
		cliBypassPermissions,
		noSkills,
		cliSkillPaths,
		noMcp,
		cliMcpPaths,
		version: VERSION,
	};

	await runTui(parsedArgs);
}

async function handleRunCommand(args: string[], version: string): Promise<void> {
	const cwd = process.env.CAST_CWD ? resolve(process.env.CAST_CWD) : resolve(".");

	let cliModel: string | undefined;
	let cliReasoning: string | undefined;
	let cliPersona: string | undefined;
	let resumeRequested = false;
	let resumeId: string | undefined;
	let cliBypassPermissions = false;
	let format: "default" | "json" = "default";
	let noSkills = false;
	const cliSkillPaths: string[] = [];
	let noMcp = false;
	const cliMcpPaths: string[] = [];
	const messageParts: string[] = [];

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--continue" || args[i] === "-c") {
			resumeRequested = true;
		} else if (args[i] === "--session" || args[i] === "-s") {
			resumeRequested = true;
			resumeId = args[i + 1];
			i++;
		} else if (args[i] === "--model" || args[i] === "-m") {
			cliModel = args[i + 1];
			i++;
		} else if (args[i] === "--reasoning" || args[i] === "-r") {
			cliReasoning = args[i + 1];
			i++;
		} else if (args[i] === "--persona" || args[i] === "-p") {
			cliPersona = args[i + 1];
			i++;
		} else if (args[i] === "--format") {
			const f = args[i + 1];
			if (f === "json") format = "json";
			i++;
		} else if (args[i] === "--bypass-permissions") {
			cliBypassPermissions = true;
		} else if (args[i] === "--skill") {
			const path = args[i + 1];
			if (path) cliSkillPaths.push(path);
			i++;
		} else if (args[i] === "--no-skills") {
			noSkills = true;
		} else if (args[i] === "--mcp") {
			const path = args[i + 1];
			if (path) cliMcpPaths.push(path);
			i++;
		} else if (args[i] === "--no-mcp") {
			noMcp = true;
		} else if (args[i] === "--help" || args[i] === "-h") {
			console.log(`Usage: cast run [options] <message>

Options:
  -c, --continue         Continue the most recent session
  -s, --session <id>     Continue a specific session by ID
  -m, --model <model>    Model to use (provider/model)
  -r, --reasoning <lvl>  Reasoning level
  -p, --persona <name>   Persona to use
  --format <default|json>  Output format
  --bypass-permissions   Skip bash confirmation prompts`);
			return;
		} else {
			messageParts.push(...args.slice(i));
			break;
		}
	}

	const message = messageParts.join(" ").trim();
	if (!message) {
		console.error("Usage: cast run [options] <message>");
		console.error("Run 'cast run --help' for options.");
		process.exit(1);
	}

	const settings = loadSettings();

	const parsedArgs: ParsedArgs = {
		cwd,
		settings,
		cliModel,
		cliReasoning,
		cliPersona,
		initialPrompt: undefined,
		resumeRequested,
		resumeId,
		resumePicker: false,
		cliBypassPermissions,
		noSkills,
		cliSkillPaths,
		noMcp,
		cliMcpPaths,
		version,
	};

	await runNonInteractive(parsedArgs, { message, format });
}

async function handleWebCommand(args: string[]): Promise<void> {
	const LOG_FILE = join(homedir(), ".cast", "web.log");

	if (args[0] === "stop") {
		await stopWebDaemon();
		return;
	}

	if (args[0] === "status") {
		printWebStatus();
		return;
	}

	const foreground = args.includes("--foreground");
	const port = getPort(args);
	const host = getHost(args);

	// Everything except lifecycle flags (subcommand, port/host/public,
	// foreground) forwards to the server process as-is — model/persona/
	// reasoning/bypass-permissions. Port and host are re-appended explicitly
	// below so the child always gets one canonical `--port`/`--host`
	// regardless of how the user spelled them (e.g. `--public` alone).
	const restArgs: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a === "start" || a === "--foreground" || a === "--public") continue;
		if (a === "--port" || a === "--host") {
			i++; // also skip this flag's value
			continue;
		}
		restArgs.push(a);
	}

	const existing = readLiveWebState();
	if (existing) {
		const mode = existing.foreground ? " (foreground)" : "";
		console.error(
			`[cast web] already running (pid ${existing.pid})${mode} — http://${existing.host}:${existing.port}`,
		);
		console.error("[cast web] use 'cast web stop' first, or 'cast web status' to check.");
		process.exit(1);
	}

	// Dev mode (tsx + .ts source) vs release mode (bundled dist/index.js).
	// import.meta.url is <repo>/src/index.ts in dev, <install>/dist/index.js in release.
	const selfPath = fileURLToPath(import.meta.url);
	const isRelease = selfPath.includes("/dist/");
	const spawnCwd = join(dirname(selfPath), "..");
	const spawnArgs = isRelease
		? [join(spawnCwd, "dist", "index.js"), "web", ...restArgs, "--port", String(port), "--host", host]
		: ["--import", "tsx", "./src/web/index.ts", ...restArgs, "--port", String(port), "--host", host];
	const spawnEnv = {
		...process.env,
		CAST_CWD: homedir(),
		CAST_WEB_PORT: String(port),
		CAST_WEB_HOST: host,
		CAST_WEB_FOREGROUND: foreground ? "1" : "0",
		CAST_VERSION: VERSION,
	};

	// Foreground: run inline. Daemon: spawn child. Daemon child: run inline.
	// CAST_WEB_FOREGROUND distinguishes daemon-child from the launcher:
	// "0" = I am the daemon child, run inline (set by spawnEnv below).
	// "1" = user asked --foreground, run inline (set by the CLI flag).
	// unset = I am the launcher, spawn a child.
	if (foreground || process.env.CAST_WEB_FOREGROUND === "0") {
		process.env.CAST_WEB_SKIP_AUTORUN = "1";
		const { runWebServerMain } = await import("./web/index.ts");
		runWebServerMain(args, { foreground, version: VERSION });
		return;
	}

	// Daemon mode: spawn detached, then wait for the child to actually report
	// success (its own state-file write, once really listening) or failure
	// (it exits early — bad port, crash) instead of declaring victory the
	// instant spawn() returns, which is true whether or not the child goes
	// on to bind at all.
	const logFd = openSync(LOG_FILE, "a");
	const child = spawn(process.execPath, spawnArgs, {
		cwd: spawnCwd,
		detached: true,
		stdio: ["ignore", logFd, logFd],
		env: spawnEnv,
	});
	child.unref();

	const started = await waitForStartup(child.pid!);
	if (!started) {
		console.error(`[cast web] failed to start — see ${LOG_FILE} for details`);
		process.exit(1);
	}
	console.log(`[cast web] started (pid ${child.pid}) — http://${host}:${port}`);
	console.log(`[cast web] logs: ${LOG_FILE}`);
	console.log(`[cast web] stop: cast web stop`);
}

/** Polls for the child's own state-file write (real success) or its early exit (real failure), up to 5s. */
function waitForStartup(pid: number): Promise<boolean> {
	return new Promise((resolvePromise) => {
		let settled = false;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearInterval(poll);
			resolvePromise(ok);
		};
		const poll = setInterval(() => {
			const state = readWebState();
			if (state?.pid === pid) finish(true);
			else if (!isProcessAlive(pid)) finish(false);
		}, 150);
		setTimeout(() => finish(false), 5000).unref();
	});
}

function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolvePromise) => {
		const start = Date.now();
		const poll = setInterval(() => {
			if (!isProcessAlive(pid)) {
				clearInterval(poll);
				resolvePromise(true);
			} else if (Date.now() - start >= timeoutMs) {
				clearInterval(poll);
				resolvePromise(false);
			}
		}, 100);
	});
}

async function stopWebDaemon(): Promise<void> {
	const state = readWebState();
	if (!state) {
		console.log("[cast web] not running");
		return;
	}
	if (!isProcessAlive(state.pid)) {
		// Killed out from under us — by the OS, an OOM killer, or the user
		// directly. Nothing to signal; just say so honestly and clean up
		// instead of claiming to have "stopped" a process that was already gone.
		console.log(`[cast web] was not actually running (pid ${state.pid} is gone) — stale state cleaned up`);
		clearWebState();
		return;
	}

	process.kill(state.pid, "SIGTERM");
	let died = await waitForExit(state.pid, 3000);
	if (!died) {
		// The in-process SIGTERM handler didn't finish in time (slow session
		// drain, or an old build without the handler at all) — escalate
		// rather than leave the caller thinking `stop` silently did nothing.
		try {
			process.kill(state.pid, "SIGKILL");
		} catch {
			/* already gone */
		}
		died = await waitForExit(state.pid, 1000);
	}
	clearWebState();
	console.log(`[cast web] stopped (pid ${state.pid}) — was on http://${state.host}:${state.port}`);
	if (!died) console.log("[cast web] warning: process may not have fully exited");
}

function printWebStatus(): void {
	const state = readWebState();
	if (!state) {
		console.log("[cast web] not running");
		return;
	}
	if (!isProcessAlive(state.pid)) {
		console.log("[cast web] stale state — process not running");
		clearWebState();
		return;
	}
	const mode = state.foreground ? " (foreground)" : "";
	console.log(`[cast web] running (pid ${state.pid})${mode} — http://${state.host}:${state.port}`);
	console.log(`[cast web] started: ${state.startedAt}`);
}

function getPort(args: string[]): number {
	const idx = args.indexOf("--port");
	if (idx >= 0 && args[idx + 1]) return parseInt(args[idx + 1]!, 10);
	return parseInt(process.env.CAST_WEB_PORT ?? "1337", 10);
}

function getHost(args: string[]): string {
	const idx = args.indexOf("--host");
	if (idx >= 0 && args[idx + 1]) return args[idx + 1]!;
	if (args.includes("--public")) return "0.0.0.0";
	return process.env.CAST_WEB_HOST ?? "127.0.0.1";
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
