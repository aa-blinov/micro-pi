/**
 * Shared types and small helpers used across every tool implementation
 * (bash, files, search, task) and the dispatcher in ../tools.ts. Kept in one
 * place so the individual tool modules don't have to import each other just to
 * reach a common path/size helper or the ToolResult shape.
 */

import { isAbsolute, resolve } from "node:path";
import type { Usage } from "../llm.ts";

export interface ToolResult {
	content: string;
	isError?: boolean;
	/**
	 * Set by `read` when the file is an image. A `role: "tool"` message can't
	 * carry image content per the OpenAI-compatible chat API, so the loop
	 * follows it up with a separate `role: "user"` image message instead.
	 */
	imageDataUrl?: string;
	/** Usage from subagent execution (task tool only). */
	subagentUsage?: Usage;
}

export type ToolExecutor = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;

/** Asked before running a bash command that matches a known-dangerous pattern. Return false to block it. */
export type ConfirmBash = (command: string, reason: string) => Promise<boolean>;

/** Resolve a possibly-relative tool path argument against the agent's cwd. */
export function resolvePath(path: string, cwd: string): string {
	if (isAbsolute(path)) return path;
	return resolve(cwd, path);
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
