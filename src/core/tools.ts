import type { AppConfig } from "./config.ts";
import type { Tool } from "./llm.ts";
import type { PlanState } from "./plan.ts";
import {
	execPlanCheck,
	execPlanDiscard,
	execPlanDone,
	execPlanEdit,
	execPlanEnter,
	execPlanRead,
	execPlanWrite,
} from "./plan.ts";
import type { SshHost } from "./ssh.ts";
import { execBash } from "./tools/bash.ts";
import { execEdit, execRead, execWrite } from "./tools/files.ts";
import { execGlob, execGrep, execLs } from "./tools/search.ts";
import type { ConfirmBash, ToolExecutor, ToolResult } from "./tools/shared.ts";
import { execSsh } from "./tools/ssh.ts";
import { execTask, type TaskExecutorDeps } from "./tools/task.ts";
import { execWebFetch, execWebSearch } from "./tools/web.ts";

// Re-export the public tool types so existing importers of "./tools.ts"
// (loop.ts, mcp.ts, tests) keep working after the split into tools/*.
export type { ConfirmBash, ToolExecutor, ToolResult } from "./tools/shared.ts";
export type { TaskExecutorDeps } from "./tools/task.ts";

// ============================================================================
// Tool definitions (OpenAI function calling format)
// ============================================================================

export function getToolDefinitions(
	personaNames?: string[],
	mainModel?: string,
	subagentModel?: string,
	sshHostNames?: string[],
): Tool[] {
	const personaList =
		personaNames && personaNames.length > 0
			? `Available subagents: ${personaNames.join(", ")}. Defaults to "${personaNames.includes("worker") ? "worker" : personaNames[0]}" if omitted.`
			: "";
	const modelInfo = subagentModel && subagentModel !== mainModel ? ` Subagent model: ${subagentModel}.` : "";

	return [
		{
			type: "function",
			function: {
				name: "bash",
				description:
					"Execute a bash command in the current working directory. Returns stdout and stderr. " +
					"Output is truncated to last 2000 lines or 64KB (whichever is hit first). " +
					"Default timeout 180s. For long-running commands (docker build, npm install, large test suites), " +
					"pass a higher timeout value. " +
					"Do NOT re-run an identical command to 'double-check' a result you already have — the previous " +
					"output still holds unless something changed. Running the same command repeatedly is treated as a " +
					"doom loop and blocked.",
				parameters: {
					type: "object",
					properties: {
						command: { type: "string", description: "Bash command to execute" },
						timeout: {
							type: "number",
							description:
								"Timeout in seconds. Default 180. Increase for long-running commands (e.g. 600 for docker build)",
						},
					},
					required: ["command"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "read",
				description:
					"Read the contents of a file. When you already know the path, call this directly — do not search with glob/ls first. " +
					"Supports text files and images (jpg, jpeg, png, gif, webp, bmp — " +
					"shown to you as an image in the next message; only works if the model supports vision). " +
					"Output is truncated to 2000 lines or 64KB. Use offset/limit for large files. " +
					"Images larger than 5MB are rejected. " +
					"Each line is prefixed with `<LINE>:<LOCAL>:<CHUNK>→content` (a hashline anchor, e.g. `22:abc:rst`) — copy the full three-part prefix into `edit`. " +
					"You already have the contents of every file you read earlier in this session — do NOT read the " +
					"same path again unless it has changed since (e.g. you just edited it); re-use the earlier result " +
					"instead. Reading the same unchanged file repeatedly is treated as a doom loop and blocked.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Path to the file to read (relative or absolute)" },
						offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
						limit: { type: "number", description: "Maximum number of lines to read" },
					},
					required: ["path"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "write",
				description:
					"Create a new file or overwrite an entire file. Prefer `edit` for surgical changes to existing files. " +
					"Automatically creates parent directories.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Path to the file to write (relative or absolute)" },
						content: { type: "string", description: "Content to write to the file" },
					},
					required: ["path", "content"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "edit",
				description:
					"Edit a file using hashline anchors from a recent `read` or `grep`. " +
					"Copy the full `<line>:<local>:<chunk>` prefix (include the line number). " +
					"Put every change to this file in one call's ops[] — do not split into multiple edit rounds. " +
					"Ops: 'replace' (one line or `anchor`+`end_anchor` range; INCLUSIVE on both ends), " +
					"'insert_after' / 'insert_before' (add lines after/before an anchor), 'write' (replace the whole file). " +
					"Success returns fresh anchors — use them for any follow-up; do not re-read just to confirm. " +
					"Moved lines, neighbour drift, and unique hash-only anchors (missing line number) are recovered automatically; " +
					"errors include fresh anchors so a re-read is usually unnecessary.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
						ops: {
							type: "array",
							items: {
								type: "object",
								properties: {
									op: {
										type: "string",
										enum: ["replace", "insert_after", "insert_before", "write"],
										description: "Kind of edit operation.",
									},
									anchor: {
										type: "string",
										description:
											"Full hashline anchor `<line>:<local>:<chunk>` from read/grep (e.g. `22:abc:rst`). Include the line number. Pasting the whole gutter (`22:abc:rst→…`) is fine. For insert_after: `0:` = top of file, `EOF` = append at end.",
									},
									end_anchor: {
										type: "string",
										description:
											"Optional second anchor for `replace`; the range from `anchor` to `end_anchor` (inclusive) is replaced by `content`. Without it exactly one line is replaced, regardless of how many lines `content` has.",
									},
									content: {
										type: "string",
										description:
											"New text to write at the target range / after the anchor / as the new file content. Newlines split it into multiple lines. An empty string on `replace` deletes the range.",
									},
								},
								required: ["op", "content"],
							},
							description:
								"One or more anchor-based edit operations, applied atomically against the pre-edit file.",
						},
					},
					required: ["path", "ops"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "glob",
				description:
					"Search for files by glob pattern (e.g. '*.ts', '**/*.json', 'src/**/*.spec.ts'). " +
					"Only when the path is unknown. If the user already named a file (greet.ts, CHANGELOG.md, config, …), " +
					"call `read` on that name first — do not glob. One glob call is enough; then read a hit.",
				parameters: {
					type: "object",
					properties: {
						pattern: { type: "string", description: "Glob pattern to match files" },
						path: { type: "string", description: "Directory to search in (default: current directory)" },
						limit: { type: "number", description: "Maximum number of results (default: 1000)" },
					},
					required: ["pattern"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "grep",
				description:
					"Search file contents by regex pattern. Supports context lines, case-insensitive, literal mode.",
				parameters: {
					type: "object",
					properties: {
						pattern: { type: "string", description: "Search pattern (regex or literal string)" },
						path: { type: "string", description: "Directory or file to search (default: current directory)" },
						glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts'" },
						ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" },
						literal: { type: "boolean", description: "Treat pattern as literal string (default: false)" },
						context: { type: "number", description: "Lines before/after each match (default: 0)" },
						limit: { type: "number", description: "Maximum number of matches (default: 100)" },
					},
					required: ["pattern"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "ls",
				description:
					"List directory contents (type, size, name). For locating a named file use `read` or `glob`, not ls.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Directory to list (default: current directory)" },
						limit: { type: "number", description: "Maximum number of entries (default: 500)" },
					},
				},
			},
		},
		{
			type: "function",
			function: {
				name: "web_search",
				description:
					"Search the web via DuckDuckGo. Returns titles, URLs, and snippets. " +
					"No API key required. Good for finding current information, documentation, " +
					"and answers to questions that require up-to-date knowledge.",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "Search query" },
						maxResults: {
							type: "number",
							description: "Maximum number of results (default: 10)",
						},
						region: {
							type: "string",
							description: "Region code, e.g. 'us-en', 'ru-ru', 'wt-wt' (default: wt-wt)",
						},
						time: {
							type: "string",
							description: "Time filter: 'd' (day), 'w' (week), 'm' (month), 'y' (year)",
						},
					},
					required: ["query"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "web_fetch",
				description:
					"Fetch a web page and return clean markdown via Jina Reader. " +
					"Handles JS rendering, PDFs, and content extraction. " +
					"Useful for reading articles, documentation, and any web content.",
				parameters: {
					type: "object",
					properties: {
						url: { type: "string", description: "URL to fetch" },
						maxChars: {
							type: "number",
							description: "Maximum characters to return (default: 12000)",
						},
					},
					required: ["url"],
				},
			},
		},
		...(personaNames?.length
			? [
					{
						type: "function" as const,
						function: {
							name: "task",
							description:
								"Start a subagent that works on a task independently and reports back. " +
								"Child tool calls stay out of your context — only the final result is returned. " +
								"When the user asks for parallel/independent/concurrent work across separate areas, " +
								"emit multiple task calls in the same turn (one assignment per area) instead of doing all the reads yourself. " +
								`Also use for isolated research, review, or exploration. ${personaList}${modelInfo}`,
							parameters: {
								type: "object",
								properties: {
									assignment: {
										type: "string",
										description: "Complete, self-contained task description for the subagent",
									},
									subagent: {
										type: "string",
										description: "Subagent name (optional). Example: 'worker'",
									},
								},
								required: ["assignment"],
							},
						},
					},
				]
			: []),
		// SSH tool — only when hosts are configured
		...(sshHostNames?.length
			? [
					{
						type: "function" as const,
						function: {
							name: "ssh",
							description:
								"Execute one command on a remote host via SSH. Hosts are configured in\n" +
								"~/.cast/ssh.json (global) or .cast/ssh.json (project). Returns combined\nstdout+stderr. Use for remote server management, deployment, debugging.\n\nAvailable hosts:\n" +
								sshHostNames.map((n) => `- ${n}`).join("\n"),
							parameters: {
								type: "object",
								properties: {
									host: {
										type: "string",
										description: "Host name key from configured SSH hosts",
									},
									command: {
										type: "string",
										description: "Remote command to execute",
									},
									timeout: {
										type: "number",
										description: "Timeout in seconds. Default 180.",
									},
								},
								required: ["host", "command"],
							},
						},
					},
				]
			: []),
		// Plan mode tools — always defined, filtered via disabledTools when not in
		// plan mode, so the model only ever sees them while /plan is active (no
		// "only available in plan mode" boilerplate needed in the descriptions).
		{
			type: "function",
			function: {
				name: "plan_write",
				description:
					"Write or replace a named plan file; the plan just written becomes the active one for plan_edit/plan_read/plan_done. " +
					"Use markdown with sections: Context, Steps (as a '- [ ]' checklist), Verification, and Assumptions when needed.",
				parameters: {
					type: "object",
					properties: {
						name: {
							type: "string",
							description: "Short descriptive kebab-case name for the plan, e.g. 'auth-refactor'",
						},
						content: {
							type: "string",
							description: "Full plan markdown content",
						},
					},
					required: ["name", "content"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "plan_edit",
				description:
					"Edit a section of the active plan by matching its heading (case-insensitive; exact match wins over substring). " +
					"Replaces the section body while preserving the heading.",
				parameters: {
					type: "object",
					properties: {
						heading: {
							type: "string",
							description: "Section heading to match (case-insensitive; exact match wins over substring)",
						},
						content: {
							type: "string",
							description: "New content for that section (heading is preserved)",
						},
					},
					required: ["heading", "content"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "plan_read",
				description:
					"Read a plan's content and headings, plus the names of all plans in this session. " +
					"In plan mode the plan read becomes the active one for plan_edit/plan_done — use `name` to switch between plans. " +
					"In build mode it is reference-only.",
				parameters: {
					type: "object",
					properties: {
						name: {
							type: "string",
							description: "Plan name to read (omit for the currently active plan)",
						},
					},
				},
			},
		},
		{
			type: "function",
			function: {
				name: "plan_done",
				description: "Signal that the active plan is complete and ready for user review.",
				parameters: {
					type: "object",
					properties: {
						summary: {
							type: "string",
							description: "One-line summary of what the plan covers",
						},
					},
				},
			},
		},
		{
			type: "function",
			function: {
				name: "plan_discard",
				description:
					"Delete a plan from this session (e.g. an abandoned draft the user asked to drop). " +
					"If it was the active plan, the newest remaining one becomes active.",
				parameters: {
					type: "object",
					properties: {
						name: {
							type: "string",
							description: "Name of the plan to discard",
						},
					},
					required: ["name"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "plan_enter",
				description:
					"Suggest switching to plan mode when the user's request is complex enough to benefit from planning " +
					"before implementation (multiple files, architectural decisions, unclear scope). The user is asked to " +
					"confirm — call this, then END YOUR TURN and wait. Do not call it for simple, direct tasks.",
				parameters: {
					type: "object",
					properties: {
						reason: {
							type: "string",
							description: "One sentence on why this task benefits from planning first",
						},
					},
					required: ["reason"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "plan_check",
				description:
					"Mark a checklist item in the approved plan as done ('- [ ]' → '- [x]'). " +
					"Call it right after completing each plan step.",
				parameters: {
					type: "object",
					properties: {
						item: {
							type: "string",
							description: "Text of the checklist item (case-insensitive; exact match wins over substring)",
						},
						plan: {
							type: "string",
							description: "Plan name to check the item off in (omit for the active plan)",
						},
						index: {
							type: "number",
							description: "1-based pick when several items match the same text (from the ambiguity error)",
						},
					},
					required: ["item"],
				},
			},
		},
	];
}

// ============================================================================
// Tool execution — dispatches a tool call to its implementation module.
// ============================================================================

export function createToolExecutor(
	cwd: string,
	config: AppConfig,
	confirmBash?: ConfirmBash,
	taskDeps?: TaskExecutorDeps,
	planState?: PlanState,
	sshHosts?: SshHost[],
): ToolExecutor {
	return async (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> => {
		try {
			switch (name) {
				case "bash":
					return await execBash(args, cwd, config, confirmBash, signal);
				case "read":
					return await execRead(args, cwd, config);
				case "write":
					return await execWrite(args, cwd);
				case "edit":
					return await execEdit(args, cwd, config);
				case "glob":
				case "find": // legacy alias — same implementation as glob
					return await execGlob(args, cwd, config);
				case "grep":
					return await execGrep(args, cwd, config);
				case "ls":
					return await execLs(args, cwd, config);
				case "web_search":
					return await execWebSearch(args, signal);
				case "web_fetch":
					return await execWebFetch(args, signal);
				case "ssh":
					return await execSsh(args, sshHosts ?? [], config, confirmBash, signal);
				case "task":
					if (!taskDeps)
						return { content: "Task tool not available — no dependencies configured.", isError: true };
					return await execTask(args, cwd, config, taskDeps, signal);
				case "plan_write":
					if (!planState) return { content: "Plan tool not available.", isError: true };
					return execPlanWrite(args, planState);
				case "plan_edit":
					if (!planState) return { content: "Plan tool not available.", isError: true };
					return execPlanEdit(args, planState);
				case "plan_read":
					if (!planState) return { content: "Plan tool not available.", isError: true };
					return execPlanRead(args, planState);
				case "plan_done":
					if (!planState) return { content: "Plan tool not available.", isError: true };
					return execPlanDone(args, planState);
				case "plan_check":
					if (!planState) return { content: "Plan tool not available.", isError: true };
					return execPlanCheck(args, planState);
				case "plan_enter":
					if (!planState) return { content: "Plan tool not available.", isError: true };
					return execPlanEnter(args, planState);
				case "plan_discard":
					if (!planState) return { content: "Plan tool not available.", isError: true };
					return execPlanDiscard(args, planState);
				default:
					return { content: `Unknown tool: ${name}`, isError: true };
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { content: message, isError: true };
		}
	};
}
