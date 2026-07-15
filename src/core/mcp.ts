/**
 * MCP (Model Context Protocol) client support — stdio servers, plus remote
 * (streamable HTTP) servers authenticated with a static header/token, like
 * Context7's published `{ "url": ..., "headers": { "X-API-KEY": ... } }`
 * config. Uses the official @modelcontextprotocol/sdk for the protocol
 * itself (handshake, tools/list, tools/call, both transports); this module
 * is just the thin part specific to cast: config loading, name-spacing
 * tool names per server, and converting MCP's tool/result shapes into the
 * ones tools.ts already uses (Tool for definitions, ToolResult for call
 * outcomes) so the rest of the codebase doesn't need to know MCP tools are
 * any different from the built-in ones.
 *
 * Deliberately not supporting OAuth (browser redirect, token storage/
 * refresh, local callback server) — that's a meaningfully bigger surface
 * than "send this header on every request," and static-header auth already
 * covers a lot of real remote servers (Context7 included). Worth doing if
 * something concrete needs it.
 */

import { existsSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "./llm.ts";
import type { ToolResult } from "./tools.ts";

export interface McpServerConfig {
	// stdio (local process)
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	// remote (streamable HTTP), static-header auth only — no OAuth
	url?: string;
	headers?: Record<string, string>;
}

interface McpConfigFile {
	mcpServers?: Record<string, McpServerConfig>;
}

/** Reads a `{ "mcpServers": { "name": { "command": ..., "args": [...] } } }` file — same shape Claude Desktop/Cursor/etc. already use, so existing configs can be copy-pasted. Missing file or malformed JSON both just mean "no servers", not an error. */
export function loadMcpConfig(path: string): Record<string, McpServerConfig> {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as McpConfigFile;
		return parsed.mcpServers ?? {};
	} catch {
		return {};
	}
}

/** OpenAI function-calling tool names are restricted to [a-zA-Z0-9_-]; server/tool names aren't guaranteed to be. */
export function sanitizeToolNamePart(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function mcpToolName(serverName: string, toolName: string): string {
	return `mcp_${sanitizeToolNamePart(serverName)}_${sanitizeToolNamePart(toolName)}`;
}

export interface McpToolHandle {
	definition: Tool;
	call: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;
}

export interface McpConnection {
	serverName: string;
	toolCount: number;
	client: Client;
}

export interface McpSetupResult {
	toolIndex: Map<string, McpToolHandle>;
	toolDefinitions: Tool[];
	connections: McpConnection[];
	diagnostics: string[];
	/** Every server name from the original config, regardless of connection
	 * success or disabled state — so the /mcp picker can show the full list. */
	allServerNames: string[];
}

// The common `npx -y <package>` config style (same one Claude Desktop/Cursor
// suggest) has to resolve the package against the npm registry before the
// server process even starts — confirmed empirically: ~2.6s with a warm npx
// cache, ~12s with a cold one (fresh $HOME, no prior npx runs), on ordinary
// network conditions. 10s cut that off mid-resolution; 30s leaves real room
// without leaving a genuinely hung server unnoticed for too long.
const CONNECT_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<T>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	// Clear the timer once the real promise settles so a fast success doesn't
	// leave a pending timer keeping the event loop (and process exit) alive.
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface McpContentPart {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	uri?: string;
	name?: string;
	description?: string;
	resource?: { uri: string; mimeType?: string; text?: string; blob?: string };
}

/**
 * Custom fetch for Streamable HTTP MCP servers that declines the transport's
 * standalone GET SSE "listening" stream (returns a synthetic 405 for GET).
 *
 * Why: the SDK opens a long-lived GET SSE stream for unsolicited server
 * messages. Node's built-in fetch (undici) serializes work on a kept-alive
 * HTTP/1.1 connection, so while that stream is held open the responses to
 * subsequent POSTs never arrive — every tool call (and the initial tools/list)
 * hangs until the SDK's 60s request timeout fires. Observed with servers that
 * accept the GET stream and keep it open (e.g. https://mcp.bitrix24.tech/mcp/);
 * confirmed that declining the stream makes the same server respond in ~400ms.
 *
 * The GET stream is optional per the MCP spec (the SDK already handles a 405 by
 * skipping it), and every request/response result still arrives on that POST's
 * own SSE body — so tools work fully. The only thing forgone is unsolicited
 * server→client notifications, which cast does not consume (it lists tools once
 * at startup). GET is used solely for this listening stream; POST/DELETE (send,
 * session terminate) pass through to the real fetch untouched.
 */
export function mcpHttpFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
	if ((init?.method ?? "GET") === "GET") {
		return Promise.resolve(new Response(null, { status: 405, statusText: "SSE listening stream declined" }));
	}
	return fetch(url as Parameters<typeof fetch>[0], init);
}

/**
 * Connects to every configured server in parallel — one slow/hung server
 * (bad command, server that never responds) shouldn't block the others, so
 * each gets its own connect timeout and a failure here becomes a diagnostic,
 * not a thrown error that takes the rest down with it.
 */
export async function connectMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetupResult> {
	const toolIndex = new Map<string, McpToolHandle>();
	const toolDefinitions: Tool[] = [];
	const connections: McpConnection[] = [];
	const diagnostics: string[] = [];

	await Promise.all(
		Object.entries(servers).map(async ([serverName, cfg]) => {
			const client = new Client({ name: "cast", version: "1.0.0" });

			let transport: Transport;
			if (cfg.url) {
				transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
					requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
					fetch: mcpHttpFetch,
				});
			} else if (cfg.command) {
				transport = new StdioClientTransport({ command: cfg.command, args: cfg.args, env: cfg.env, cwd: cfg.cwd });
			} else {
				diagnostics.push(
					`mcp server "${serverName}": needs either "command" (local) or "url" (remote) in its config`,
				);
				return;
			}

			try {
				await withTimeout(
					client.connect(transport),
					CONNECT_TIMEOUT_MS,
					`didn't respond within ${CONNECT_TIMEOUT_MS / 1000}s`,
				);
				const tools: Awaited<ReturnType<typeof client.listTools>>["tools"] = [];
				let cursor: string | undefined;
				do {
					const page = await client.listTools(cursor ? { cursor } : undefined);
					tools.push(...page.tools);
					cursor = page.nextCursor;
				} while (cursor);

				for (const t of tools) {
					const name = mcpToolName(serverName, t.name);
					const definition: Tool = {
						type: "function",
						function: {
							name,
							description: `[${serverName}] ${t.description ?? t.name}`,
							parameters: t.inputSchema as Record<string, unknown>,
						},
					};
					toolDefinitions.push(definition);
					toolIndex.set(name, {
						definition,
						call: async (args, signal): Promise<ToolResult> => {
							try {
								const result = await client.callTool({ name: t.name, arguments: args }, undefined, { signal });
								const parts = (result.content ?? []) as McpContentPart[];
								const fragments: string[] = [];
								let image: McpContentPart | undefined;
								let extraImages = 0;

								for (const p of parts) {
									if (p.type === "text" && p.text) {
										fragments.push(p.text);
									} else if (p.type === "image" && p.data && p.mimeType) {
										if (!image) image = p;
										else extraImages++;
									} else if (p.type === "audio" && p.mimeType) {
										fragments.push(`[audio content omitted: ${p.mimeType}]`);
									} else if (p.type === "resource_link" && p.uri) {
										const label = p.name ?? p.uri;
										fragments.push(
											`[resource link: ${label} (${p.uri})${p.description ? ` — ${p.description}` : ""}]`,
										);
									} else if (p.type === "resource" && p.resource) {
										if (p.resource.text !== undefined) {
											fragments.push(p.resource.text);
										} else {
											fragments.push(
												`[embedded resource: ${p.resource.uri}${p.resource.mimeType ? ` (${p.resource.mimeType})` : ""}]`,
											);
										}
									}
								}
								if (extraImages > 0) fragments.push(`[${extraImages} additional image(s) omitted]`);

								return {
									content: fragments.join("\n") || "(no output)",
									isError: Boolean(result.isError),
									imageDataUrl: image ? `data:${image.mimeType};base64,${image.data}` : undefined,
								};
							} catch (error) {
								return { content: error instanceof Error ? error.message : String(error), isError: true };
							}
						},
					});
				}

				connections.push({ serverName, toolCount: tools.length, client });
			} catch (error) {
				diagnostics.push(`mcp server "${serverName}": ${error instanceof Error ? error.message : String(error)}`);
				await client.close().catch(() => {});
			}
		}),
	);

	return { toolIndex, toolDefinitions, connections, diagnostics, allServerNames: Object.keys(servers) };
}

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Format connected MCP servers for the system prompt as <available_mcp>.
 * Only currently enabled servers appear — disabled ones are excluded entirely.
 * If a server is configured in mcp.json but missing here, the user has
 * disabled it via /mcp; do not attempt to call its tools. */
export function formatMcpForPrompt(result: McpSetupResult): string {
	if (result.connections.length === 0) return "";
	const lines = ["\n<available_mcp>", "  <!-- Only enabled MCP servers are listed. -->"];
	for (const c of result.connections) {
		lines.push(`  <server name="${escapeXml(c.serverName)}" tools="${c.toolCount}">`);
		for (const t of result.toolDefinitions) {
			if (t.function.description?.startsWith(`[${c.serverName}]`)) {
				lines.push(`    <tool>${escapeXml(t.function.name)}</tool>`);
			}
		}
		lines.push("  </server>");
	}
	lines.push("</available_mcp>");
	return lines.join("\n");
}

export async function closeMcpConnections(connections: McpConnection[]): Promise<void> {
	await Promise.all(connections.map((c) => c.client.close().catch(() => {})));
}
