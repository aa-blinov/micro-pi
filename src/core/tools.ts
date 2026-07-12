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
import { execBash } from "./tools/bash.ts";
import { execEdit, execRead, execWrite } from "./tools/files.ts";
import { execFind, execGrep, execLs } from "./tools/search.ts";
import type { ConfirmBash, ToolExecutor, ToolResult } from "./tools/shared.ts";
import { execTask, type TaskExecutorDeps } from "./tools/task.ts";
import { execWebFetch, execWebSearch } from "./tools/web.ts";

// Re-export the public tool types so existing importers of "./tools.ts"
// (loop.ts, mcp.ts, tests) keep working after the split into tools/*.
export type { ConfirmBash, ToolExecutor, ToolResult } from "./tools/shared.ts";
export type { TaskExecutorDeps } from "./tools/task.ts";

// ============================================================================
// Tool definitions (OpenAI function calling format)
// ============================================================================

export function getToolDefinitions(personaNames?: string[], mainModel?: string, subagentModel?: string): Tool[] {
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
					"pass a higher timeout value.",
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
					"Read the contents of a file. Supports text files and images (jpg, jpeg, png, gif, webp, bmp — " +
					"shown to you as an image in the next message; only works if the model supports vision). " +
					"Output is truncated to 2000 lines or 64KB. Use offset/limit for large files. " +
					"Images larger than 5MB are rejected.",
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
					"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. " +
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
					"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, " +
					"non-overlapping region of the original file. If two changes touch the same block or nearby lines, " +
					"merge them into one edit instead of emitting overlapping edits.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
						edits: {
							type: "array",
							items: {
								type: "object",
								properties: {
									oldText: {
										type: "string",
										description: "Exact text for one targeted replacement. Must be unique in the file.",
									},
									newText: { type: "string", description: "Replacement text for this targeted edit." },
								},
								required: ["oldText", "newText"],
							},
							description: "One or more targeted replacements. Each is matched against the original file.",
						},
					},
					required: ["path", "edits"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "find",
				description: "Search for files by glob pattern (e.g. '*.ts', '**/*.json', 'src/**/*.spec.ts').",
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
				description: "List directory contents. Shows file type, size, and name.",
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
								"Delegate a task to a subagent with an isolated context. " +
								"The subagent runs independently — its intermediate tool calls do not appear in your context. " +
								"Only the final result is returned to you. " +
								`Use for parallel work, research, or isolating complex exploration. ${personaList}${modelInfo}`,
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
					return await execEdit(args, cwd);
				case "find":
					return await execFind(args, cwd, config);
				case "grep":
					return await execGrep(args, cwd, config);
				case "ls":
					return await execLs(args, cwd, config);
				case "web_search":
					return await execWebSearch(args, signal);
				case "web_fetch":
					return await execWebFetch(args, signal);
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
