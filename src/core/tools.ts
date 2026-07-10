import type { AppConfig } from "./config.ts";
import type { Tool } from "./llm.ts";
import { execBash } from "./tools/bash.ts";
import { execEdit, execRead, execWrite } from "./tools/files.ts";
import { execFind, execGrep, execLs } from "./tools/search.ts";
import type { ConfirmBash, ToolExecutor, ToolResult } from "./tools/shared.ts";
import { execTask, type TaskExecutorDeps } from "./tools/task.ts";

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
					"Optionally provide a timeout in seconds.",
				parameters: {
					type: "object",
					properties: {
						command: { type: "string", description: "Bash command to execute" },
						timeout: { type: "number", description: "Timeout in seconds (optional)" },
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
				case "task":
					if (!taskDeps)
						return { content: "Task tool not available — no dependencies configured.", isError: true };
					return await execTask(args, cwd, config, taskDeps, signal);
				default:
					return { content: `Unknown tool: ${name}`, isError: true };
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { content: message, isError: true };
		}
	};
}
