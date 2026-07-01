import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { runOnboardingCheck } from "./core/config.ts";
import { formatContextFilesForPrompt, loadProjectContextFiles } from "./core/context-files.ts";
import { CAST_BANNER, printHelp, printInteractiveHelp } from "./core/help.ts";
import { compactSessionMessages } from "./core/loop.ts";
import { closeMcpConnections, type McpSetupResult } from "./core/mcp.ts";
import { findPersona, listPersonas } from "./core/personas.ts";
import { buildSystemPrompt, resolveMcpForCwd, resolveProjectTrustForCwd, resolveSkillsForCwd } from "./core/project.ts";
import { runPrompt } from "./core/prompt.ts";
import {
	ask,
	createRl,
	getModelsCache,
	isQuestionActive,
	PASTE_NEWLINE_PLACEHOLDER,
	restoreBracketedPaste,
} from "./core/readline.ts";
import { formatRulesForPrompt, loadRules, readProjectRules, saveProjectRules } from "./core/rules.ts";
import {
	addUsage,
	createSession,
	deleteSession,
	estimateTokens,
	formatSessionList,
	listSessions,
	saveSession,
} from "./core/session.ts";
import { loadSettings, type PermissionMode, updateSettings } from "./core/settings.ts";
import { formatSkillInvocation } from "./core/skills.ts";
import { type ParsedArgs, runStartup } from "./core/startup.ts";
import { fetchLatestVersion, isNewerVersion, isReleaseInstall, runUpgrade } from "./core/upgrade.ts";
import { getReasoningOptions, type ModelReasoningMeta } from "./core/vendors.ts";
import { selectModel, selectPermissionMode, selectPersona, selectReasoningLevel } from "./pickers/domain.ts";
import { createReadlinePickers } from "./pickers/readline.ts";
import { gradientBanner } from "./ui/gradient.ts";
import { runTui } from "./ui/tui.tsx";

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

	let cwd = process.env.CAST_CWD ? resolve(process.env.CAST_CWD) : resolve(".");
	const settings = loadSettings();

	let cliModel: string | undefined;
	let cliReasoning: string | undefined;
	let cliPersona: string | undefined;
	let initialPrompt: string | undefined;
	let resumeRequested = false;
	let resumeId: string | undefined;
	let resumePicker = false;
	let cliBypassPermissions = false;
	let basicMode = false;
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
		} else if (args[i] === "--basic") {
			basicMode = true;
		} else if (args[i] === "--help" || args[i] === "-h") {
			printHelp();
			return;
		} else if (args[i] === "--version" || args[i] === "-v") {
			console.log(`cast v${VERSION}${isReleaseInstall() ? "" : " (dev)"}`);
			return;
		} else {
			initialPrompt = args.slice(i).join(" ");
			break;
		}
	}

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

	// TUI mode: default when stdin/stdout are a TTY and --basic wasn't passed.
	// Falls through to the readline path otherwise (CI, non-TTY pipes, --basic).
	if (!basicMode && process.stdin.isTTY && process.stdout.isTTY) {
		await runTui(parsedArgs);
		return;
	}

	const rl = createRl();
	const result = await runStartup(parsedArgs, createReadlinePickers(rl));

	let permissionMode = result.permissionMode;
	const config = result.config;
	const runner = result.runner;
	let session = result.session;
	let mcpResult: McpSetupResult = result.mcpResult;
	let currentPersona = result.persona;
	let reasoningMeta: ModelReasoningMeta | undefined = result.reasoningMeta;
	let systemPrompt = result.systemPrompt;
	let skills = result.skills;
	let skillsPromptSuffix = result.skillsPromptSuffix;
	let contextFilesSuffix = result.contextFilesSuffix;
	let rulesSuffix = result.rulesSuffix;
	let projectTrusted = result.projectTrusted;
	const projectDeps = result.projectDeps;
	const pickers = projectDeps.pickers;
	const resumed = result.resumed;

	async function applyPermissionMode(newMode: PermissionMode): Promise<void> {
		if (newMode === "bypass" && permissionMode !== "bypass") {
			console.log("\n\x1b[33mWarning: bypass mode disables confirmation for every bash command, including");
			console.log("destructive ones (rm -rf, sudo, force-push, ...). The agent will run whatever it");
			console.log("decides to run, without asking. This is saved to settings.json for future sessions.\x1b[0m");
			const answer = (await ask(rl, 'Type "yes" to confirm: ')).trim().toLowerCase();
			if (answer !== "yes") {
				console.log("Cancelled — staying in default mode.");
				return;
			}
		}
		permissionMode = newMode;
		updateSettings({ permissionMode });
		console.log(`Permission mode: ${permissionMode}`);
	}

	const label = (text: string): string => `\x1b[90m${text.padEnd(11)}\x1b[0m`;

	console.log(gradientBanner(CAST_BANNER, VERSION));
	console.log("\x1b[90m---\x1b[0m");
	console.log(`${label("model:")}\x1b[1m${session.model}\x1b[0m`);
	console.log(`${label("persona:")}${currentPersona.label}`);
	console.log(`${label("reasoning:")}${config.reasoningLevel}`);
	console.log(`${label("session:")}${session.id}${resumed ? ` (resumed, ${session.messages.length} messages)` : ""}`);
	console.log(`${label("cwd:")}${cwd}`);
	if (mcpResult.connections.length > 0) {
		const toolCount = mcpResult.connections.reduce((sum, c) => sum + c.toolCount, 0);
		console.log(`${label("mcp:")}${mcpResult.connections.length} server(s), ${toolCount} tool(s)`);
	}
	console.log("\x1b[90m---\x1b[0m\n");

	if (!initialPrompt && isReleaseInstall()) {
		fetchLatestVersion()
			.then((latest) => {
				if (latest && isNewerVersion(VERSION, latest)) {
					console.log(`\x1b[33m[cast v${latest} is available — run "cast upgrade" to update]\x1b[0m\n`);
				}
			})
			.catch(() => {});
	}

	if (initialPrompt) {
		await runPrompt(initialPrompt, session, config, cwd, systemPrompt, runner, rl, permissionMode, mcpResult);
		saveSession(session);
		await closeMcpConnections(mcpResult.connections);
		rl.close();
		return;
	}

	let sessionSaved = false;
	const saveOnce = (): void => {
		if (sessionSaved) return;
		sessionSaved = true;
		saveSession(session);
		console.log(`\nSession saved: ${session.id}`);
	};

	let rlClosed = false;
	const promptIfIdle = (): void => {
		if (!runner.isRunning && !rlClosed) rl.prompt();
	};

	rl.on("close", () => {
		rlClosed = true;
	});
	rl.on("close", saveOnce);
	process.on("exit", saveOnce);

	async function handleLine(raw: string): Promise<void> {
		const input = raw.trim();
		if (!input) {
			promptIfIdle();
			return;
		}

		if (input === "/quit" || input === "/exit") {
			if (runner.isRunning) {
				runner.abort();
				await runner.waitForIdle();
			}
			await closeMcpConnections(mcpResult.connections);
			rl.close();
			return;
		}
		if (input === "/abort" || input === "/stop") {
			if (runner.isRunning) {
				runner.abort();
				console.log("[Aborting...]");
				await runner.waitForIdle();
			} else {
				console.log("Nothing to abort.");
			}
			promptIfIdle();
			return;
		}
		if (input.startsWith("/steer ")) {
			const text = input.slice(7).trim();
			if (!runner.isRunning) {
				console.log("Agent is not running. Use normal input instead.");
				promptIfIdle();
				return;
			}
			runner.steeringQueue.enqueue({ role: "user", content: text });
			console.log(`[Steering queued: "${text.slice(0, 50)}"]`);
			return;
		}
		if (input.startsWith("/queue ")) {
			const text = input.slice(7).trim();
			runner.followUpQueue.enqueue({ role: "user", content: text });
			console.log(`[Queued: "${text.slice(0, 50)}"]`);
			promptIfIdle();
			return;
		}
		if (input === "/queue-reset") {
			runner.followUpQueue.clear();
			runner.steeringQueue.clear();
			console.log("[Queue cleared]");
			promptIfIdle();
			return;
		}

		if (runner.isRunning) {
			console.log("[Agent is running — use /queue <msg>, /steer <msg>, or /abort]");
			return;
		}

		if (input === "/clear") {
			session.messages = [];
			saveSession(session);
			console.log("Context cleared.");
			promptIfIdle();
			return;
		}
		if (input === "/compact") {
			if (session.messages.length === 0) {
				console.log("Nothing to compact — session is empty.");
				promptIfIdle();
				return;
			}
			console.log("Compacting...");
			const compactResult = await compactSessionMessages(
				session.messages,
				config,
				session.model,
				undefined,
				(attempt, maxAttempts, reason) =>
					console.log(`[Retrying after transient error (${attempt}/${maxAttempts}): ${reason}]`),
				(usage) => addUsage(session, usage),
			);
			if (compactResult.compacted) {
				session.messages = compactResult.messages;
				console.log(
					`Compacted: ${compactResult.messagesCompacted} messages summarized (was ~${compactResult.tokensBefore} tokens).`,
				);
			} else if (compactResult.error) {
				console.log(`Compaction failed (${compactResult.error}) — history was not modified.`);
			} else {
				console.log("Nothing safe to compact yet — not enough completed turns in the history.");
			}
			promptIfIdle();
			return;
		}
		if (input === "/new") {
			if (session.messages.length > 0) saveSession(session);
			session = createSession(session.model, cwd);
			console.log(`New session: ${session.id}`);
			promptIfIdle();
			return;
		}
		if (input === "/model") {
			console.log(`Current model: ${session.model}`);
			const selection = await selectModel(config, pickers);
			if (!selection) {
				console.log("Cancelled — model unchanged.");
				promptIfIdle();
				return;
			}
			session.model = selection.model;
			reasoningMeta = selection.reasoningMeta;
			if (selection.contextWindow && selection.contextWindow > 0) config.contextWindow = selection.contextWindow;
			await selectReasoningLevel(config, session.model, pickers, reasoningMeta);
			console.log(`Model changed to: ${session.model} (reasoning: ${config.reasoningLevel})`);
			promptIfIdle();
			return;
		}
		if (input.startsWith("/model ")) {
			const newModel = input.slice(7).trim();
			console.log();
			const ok = await runOnboardingCheck(config, newModel);
			if (ok) {
				session.model = newModel;
				const found = getModelsCache().find((m) => m.id === newModel);
				reasoningMeta = found?.reasoning;
				if (found?.contextWindow && found.contextWindow > 0) config.contextWindow = found.contextWindow;
				await selectReasoningLevel(config, newModel, pickers, reasoningMeta);
				console.log(`Model changed to: ${newModel} (reasoning: ${config.reasoningLevel})`);
			}
			promptIfIdle();
			return;
		}
		if (input === "/reasoning") {
			if (!reasoningMeta) reasoningMeta = getModelsCache().find((m) => m.id === session.model)?.reasoning;
			const options = getReasoningOptions(reasoningMeta ?? null);
			if (options.length === 0) {
				console.log(`This model doesn't report reasoning support — staying "${config.reasoningLevel}".`);
			} else {
				console.log(`Current reasoning: ${config.reasoningLevel}`);
				await selectReasoningLevel(config, session.model, pickers, reasoningMeta);
				console.log(`Reasoning changed to: ${config.reasoningLevel}`);
			}
			promptIfIdle();
			return;
		}
		if (input === "/personas") {
			console.log("Available personas:\n");
			for (const p of listPersonas()) {
				const marker = p.name === currentPersona.name ? " (current)" : "";
				console.log(`  ${p.name}${marker}  ${p.label} — ${p.description}`);
			}
			promptIfIdle();
			return;
		}
		if (input === "/persona") {
			console.log(`Current persona: ${currentPersona.label} (${currentPersona.name})`);
			console.log(`  ${currentPersona.description}`);
			const selected = await selectPersona(pickers);
			if (!selected) {
				console.log("Cancelled — persona unchanged.");
				promptIfIdle();
				return;
			}
			currentPersona = selected;
			systemPrompt = buildSystemPrompt(currentPersona, contextFilesSuffix, rulesSuffix, skillsPromptSuffix, cwd);
			updateSettings({ persona: currentPersona.name });
			console.log(`Persona changed to: ${currentPersona.label}`);
			promptIfIdle();
			return;
		}
		if (input.startsWith("/persona ")) {
			const name = input.slice("/persona ".length).trim();
			const found = findPersona(name);
			if (!found) {
				console.log(`Unknown persona "${name}". Use /personas to list available ones.`);
				promptIfIdle();
				return;
			}
			currentPersona = found;
			systemPrompt = buildSystemPrompt(currentPersona, contextFilesSuffix, rulesSuffix, skillsPromptSuffix, cwd);
			updateSettings({ persona: currentPersona.name });
			console.log(`Persona changed to: ${currentPersona.label}`);
			promptIfIdle();
			return;
		}
		if (input === "/skills") {
			if (skills.length === 0) {
				console.log(
					"No skills loaded. See --skill <path> and .cast/skills/ (project) or ~/.cast/skills/ (global).",
				);
			} else {
				console.log("Available skills:\n");
				for (const skill of skills) {
					const hidden = skill.disableModelInvocation ? " (manual-only)" : "";
					console.log(`  /skill:${skill.name}${hidden}  [${skill.source}]  ${skill.description}`);
				}
			}
			promptIfIdle();
			return;
		}
		if (input === "/mcp") {
			if (mcpResult.connections.length === 0) {
				console.log(
					"No MCP servers connected. See --mcp <path>, .cast/mcp.json (project), or ~/.cast/mcp.json (global).",
				);
			} else {
				console.log("Connected MCP servers:\n");
				for (const conn of mcpResult.connections) {
					console.log(`  ${conn.serverName}  (${conn.toolCount} tool(s))`);
				}
				console.log("\nTools:\n");
				for (const tool of mcpResult.toolDefinitions) {
					console.log(`  ${tool.function.name}  ${tool.function.description ?? ""}`);
				}
			}
			promptIfIdle();
			return;
		}
		if (input === "/reload") {
			projectTrusted = await resolveProjectTrustForCwd(projectDeps, cwd);
			({ skills, skillsPromptSuffix } = await resolveSkillsForCwd(projectDeps, cwd, projectTrusted));
			contextFilesSuffix = formatContextFilesForPrompt(loadProjectContextFiles(cwd, projectTrusted));
			rulesSuffix = formatRulesForPrompt(loadRules(cwd, projectTrusted));
			systemPrompt = buildSystemPrompt(currentPersona, contextFilesSuffix, rulesSuffix, skillsPromptSuffix, cwd);
			await closeMcpConnections(mcpResult.connections);
			mcpResult = await resolveMcpForCwd(projectDeps, cwd, projectTrusted);
			console.log(`Reloaded: ${skills.length} skill(s), ${mcpResult.connections.length} mcp server(s)`);
			promptIfIdle();
			return;
		}
		if (input.startsWith("/skill:")) {
			const rest = input.slice("/skill:".length);
			const spaceIdx = rest.indexOf(" ");
			const skillName = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
			const skillArgs = spaceIdx === -1 ? undefined : rest.slice(spaceIdx + 1).trim();
			const skill = skills.find((s) => s.name === skillName);
			if (!skill) {
				console.log(`No skill named "${skillName}". Use /skills to list available skills.`);
				promptIfIdle();
				return;
			}
			await runPrompt(
				formatSkillInvocation(skill, skillArgs),
				session,
				config,
				cwd,
				systemPrompt,
				runner,
				rl,
				permissionMode,
				mcpResult,
			);
			saveSession(session);
			promptIfIdle();
			return;
		}
		if (input === "/provider") {
			console.log(`\nCurrent provider: ${config.baseURL}`);
			console.log(`API key:          ${config.apiKey.slice(0, 8)}...${config.apiKey.slice(-4)}\n`);
			const newUrl = (await ask(rl, "New base URL (Enter to keep): ")).trim();
			const newKey = (await ask(rl, "New API key (Enter to keep): ")).trim();
			const finalUrl = newUrl || config.baseURL;
			const finalKey = newKey || config.apiKey;
			if (finalUrl === config.baseURL && finalKey === config.apiKey) {
				console.log("No changes.");
				promptIfIdle();
				return;
			}
			process.stdout.write("Verifying credentials... ");
			try {
				const testClient = new OpenAI({ baseURL: finalUrl, apiKey: finalKey, fetch: globalThis.fetch });
				const list = await testClient.models.list();
				await list[Symbol.asyncIterator]().next();
				console.log("ok\n");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.log("failed");
				console.log(`  ${message.slice(0, 200)}`);
				console.log("Credentials not updated. Try again or Ctrl+C to exit.");
				promptIfIdle();
				return;
			}
			config.baseURL = finalUrl;
			config.apiKey = finalKey;
			updateSettings({ providerUrl: finalUrl, apiKey: finalKey });
			console.log(`Provider changed to: ${finalUrl}`);
			console.log("Select a model for this provider:\n");
			const selection = await selectModel(config, pickers);
			if (!selection) {
				console.log(
					"Cancelled — provider updated, but model unchanged (it may not work against the new provider).",
				);
				promptIfIdle();
				return;
			}
			session.model = selection.model;
			reasoningMeta = selection.reasoningMeta;
			if (selection.contextWindow && selection.contextWindow > 0) config.contextWindow = selection.contextWindow;
			await selectReasoningLevel(config, session.model, pickers, reasoningMeta);
			updateSettings({ model: session.model, reasoningLevel: config.reasoningLevel });
			console.log(`Model changed to: ${session.model} (reasoning: ${config.reasoningLevel})`);
			promptIfIdle();
			return;
		}
		if (input === "/permissions") {
			console.log(`Current permission mode: ${permissionMode}`);
			const newMode = await selectPermissionMode(pickers, permissionMode);
			await applyPermissionMode(newMode);
			promptIfIdle();
			return;
		}
		if (input === "/permissions default" || input === "/permissions bypass") {
			const newMode = input.endsWith("bypass") ? "bypass" : "default";
			await applyPermissionMode(newMode);
			promptIfIdle();
			return;
		}
		if (input === "/sessions") {
			while (true) {
				const sessions = listSessions()
					.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
					.slice(0, 20);
				if (sessions.length === 0) {
					console.log("No saved sessions.");
					promptIfIdle();
					return;
				}

				console.log("Saved sessions (most recent first):\n");
				for (const line of formatSessionList(sessions, session.id)) console.log(line);
				console.log(`\nEnter number (1-${sessions.length}) to switch, "d<N>" to delete, or press Enter to stay\n`);

				const choice = (await ask(rl, "Session: ")).trim();

				const delMatch = /^d(\d+)$/i.exec(choice);
				if (delMatch) {
					const num = Number.parseInt(delMatch[1]!, 10);
					if (num < 1 || num > sessions.length) {
						console.log(`No session #${num} to delete.`);
						continue;
					}
					const target = sessions[num - 1]!;
					if (target.id === session.id) {
						console.log("Cannot delete the currently active session.");
						continue;
					}
					deleteSession(target.id);
					console.log(`Deleted session ${target.id}.\n`);
					continue;
				}

				const num = Number.parseInt(choice, 10);
				if (!Number.isNaN(num) && num >= 1 && num <= sessions.length) {
					const chosen = sessions[num - 1]!;
					if (chosen.id === session.id) {
						console.log("Already in that session.");
					} else {
						if (session.messages.length > 0) saveSession(session);
						session = { ...chosen, model: session.model };
						if (chosen.cwd && chosen.cwd !== cwd) {
							if (existsSync(chosen.cwd)) {
								cwd = chosen.cwd;
								projectTrusted = await resolveProjectTrustForCwd(projectDeps, cwd);
								({ skills, skillsPromptSuffix } = await resolveSkillsForCwd(projectDeps, cwd, projectTrusted));
								contextFilesSuffix = formatContextFilesForPrompt(loadProjectContextFiles(cwd, projectTrusted));
								rulesSuffix = formatRulesForPrompt(loadRules(cwd, projectTrusted));
								systemPrompt = buildSystemPrompt(
									currentPersona,
									contextFilesSuffix,
									rulesSuffix,
									skillsPromptSuffix,
									cwd,
								);
								await closeMcpConnections(mcpResult.connections);
								mcpResult = await resolveMcpForCwd(projectDeps, cwd, projectTrusted);
								console.log(
									`Switched to session: ${session.id} (${session.messages.length} messages, cwd: ${cwd}, ${skills.length} skill(s), ${mcpResult.connections.length} mcp server(s) loaded)`,
								);
							} else {
								console.log(
									`Switched to session: ${session.id} (${session.messages.length} messages) — original directory no longer exists (${chosen.cwd}), staying in ${cwd}`,
								);
							}
						} else {
							console.log(`Switched to session: ${session.id} (${session.messages.length} messages)`);
						}
					}
				}
				break;
			}
			promptIfIdle();
			return;
		}
		if (input === "/usage") {
			const u = session.usage;
			const costLine = u.cost ? `\n  Cost:       $${u.cost.toFixed(4)}` : "";
			const cacheLine =
				u.cacheReadTokens || u.cacheWriteTokens
					? `\n  Cache read: ${u.cacheReadTokens}\n  Cache write: ${u.cacheWriteTokens}`
					: "";
			console.log(
				`Session usage:\n  Prompt:     ${u.promptTokens}\n  Completion: ${u.completionTokens}\n  Total:      ${u.totalTokens}${cacheLine}${costLine}`,
			);
			promptIfIdle();
			return;
		}
		if (input === "/context") {
			const used = estimateTokens(session.messages);
			const budget = config.contextWindow - config.maxResponseTokens;
			const pct = budget > 0 ? ((used / budget) * 100).toFixed(1) : "?";
			const triggerPct = Math.round(config.compactionThreshold * 100);
			console.log(
				`Context: ~${used.toLocaleString()} / ${budget.toLocaleString()} tokens (${pct}%, compacts at ${triggerPct}%)`,
			);
			promptIfIdle();
			return;
		}
		if (input === "/rules") {
			const existing = readProjectRules(cwd);
			if (existing) {
				process.stdout.write("Current project rules:\n\n");
				process.stdout.write(`${existing}\n`);
			} else {
				process.stdout.write("No project rules yet.\n");
			}
			process.stdout.write("\nUse /rules add to append, or edit .cast/rules.md directly.\n");
			promptIfIdle();
			return;
		}
		if (input === "/rules add") {
			const existing = readProjectRules(cwd);
			if (existing) process.stdout.write("Appending to existing rules.\n\n");
			process.stdout.write("Enter rules (multi-line). Submit with an empty line or /done:\n");
			const lines: string[] = [];
			lineHandlerPaused = true;
			rl.setPrompt("");
			rl.prompt();
			const collectLine = (line: string): void => {
				if (line.trim() === "" || line.trim() === "/done") {
					if (lines.length === 0) {
						process.stdout.write("No changes.\n");
					} else {
						const newContent = lines.join("\n");
						const combined = existing ? `${existing.trimEnd()}\n\n${newContent}` : newContent;
						saveProjectRules(cwd, combined);
						rulesSuffix = formatRulesForPrompt(loadRules(cwd, projectTrusted));
						systemPrompt = buildSystemPrompt(
							currentPersona,
							contextFilesSuffix,
							rulesSuffix,
							skillsPromptSuffix,
							cwd,
						);
						process.stdout.write(`Rules appended to ${join(cwd, ".cast", "rules.md")}.\n`);
					}
					rl.removeListener("line", collectLine);
					lineHandlerPaused = false;
					rl.setPrompt("\n\x1b[34m[user]\x1b[0m > ");
					promptIfIdle();
					return;
				}
				lines.push(line);
				rl.prompt();
			};
			rl.on("line", collectLine);
			return;
		}
		if (input === "/help") {
			printInteractiveHelp();
			promptIfIdle();
			return;
		}

		await runPrompt(input, session, config, cwd, systemPrompt, runner, rl, permissionMode, mcpResult);
		saveSession(session);
		promptIfIdle();
	}

	rl.setPrompt("\n\x1b[34m[user]\x1b[0m > ");
	rl.prompt();

	const PASTE_DEBOUNCE_MS = 60;
	let pasteBuffer: string[] = [];
	let pasteTimer: ReturnType<typeof setTimeout> | undefined;
	let lineHandlerPaused = false;

	rl.on("line", (line) => {
		if (lineHandlerPaused) return;
		if (isQuestionActive()) return;
		pasteBuffer.push(line.replaceAll(PASTE_NEWLINE_PLACEHOLDER, "\n"));
		if (pasteTimer) clearTimeout(pasteTimer);
		pasteTimer = setTimeout(() => {
			const combined = pasteBuffer.join("\n");
			pasteBuffer = [];
			pasteTimer = undefined;
			handleLine(combined).catch((err) => {
				console.error(err);
				promptIfIdle();
			});
		}, PASTE_DEBOUNCE_MS);
	});

	process.on("SIGCONT", restoreBracketedPaste);

	let lastSigintAt = 0;
	rl.on("SIGINT", () => {
		const now = Date.now();
		if (runner.isRunning) {
			runner.abort();
			console.log("\n[Aborting...]");
			lastSigintAt = now;
			return;
		}
		if (now - lastSigintAt < 2000) {
			rl.close();
			return;
		}
		console.log("\n[Press Ctrl+C again to exit]");
		lastSigintAt = now;
		promptIfIdle();
	});

	await new Promise<void>((resolve) => rl.on("close", resolve));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
