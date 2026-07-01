#!/usr/bin/env node
// Minimal real MCP server used as a test fixture for src/mcp.ts — deliberately
// not mocked, so the tests exercise the actual protocol handshake against the
// official SDK on both ends. Runs as stdio by default (`node mcp-echo-server.mjs`),
// or as a real HTTP server with `--http` (prints "LISTENING <port>" once up).
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// Set from the raw HTTP handler (below, HTTP mode only) before each request
// is dispatched to the MCP transport, so the "get-last-auth-header" tool can
// prove headers a client passed in its config actually made it onto the
// wire — exercised through the real connectMcpServers() call, not a
// separate manual fetch.
let lastAuthHeader = "none";

function buildServer() {
	const server = new McpServer({ name: "echo-fixture", version: "1.0.0" });

	server.registerTool(
		"echo",
		{ description: "Echoes back the given text.", inputSchema: { text: z.string() } },
		async ({ text }) => ({ content: [{ type: "text", text }] }),
	);

	server.registerTool(
		"add",
		{ description: "Adds two numbers.", inputSchema: { a: z.number(), b: z.number() } },
		async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
	);

	server.registerTool("fails", { description: "Always returns a tool error." }, async () => ({
		content: [{ type: "text", text: "deliberate failure" }],
		isError: true,
	}));

	server.registerTool("get-last-auth-header", { description: "Returns the X-Test-Token header of the last HTTP request." }, async () => ({
		content: [{ type: "text", text: lastAuthHeader }],
	}));

	// Gated behind --rich so the default fixture (used by most tests, which
	// assert an exact tool count/name list) stays unchanged. Exercises every
	// MCP content-block type in one response: two images (to check that only
	// the first becomes imageDataUrl and the rest are noted, not silently
	// dropped), audio, a resource_link, and an embedded (inline) resource.
	if (process.argv.includes("--rich")) {
		server.registerTool("rich-content", { description: "Returns every MCP content type in one result." }, async () => ({
			content: [
				{ type: "text", text: "hello text" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				{ type: "image", data: "d29ybGQ=", mimeType: "image/png" },
				{ type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
				{
					type: "resource_link",
					uri: "file:///tmp/example.txt",
					name: "example.txt",
					description: "an example file",
				},
				{
					type: "resource",
					resource: { uri: "file:///tmp/inline.txt", mimeType: "text/plain", text: "inline resource text" },
				},
			],
		}));
	}

	// Gated behind --paginate: replaces the auto-generated tools/list handler
	// with one that hands out two tools across two pages, so tests can prove
	// connectMcpServers() actually follows nextCursor instead of only reading
	// the first page.
	if (process.argv.includes("--paginate")) {
		const pages = [
			{ name: "page-a", description: "First page tool.", inputSchema: { type: "object", properties: {} } },
			{ name: "page-b", description: "Second page tool.", inputSchema: { type: "object", properties: {} } },
		];
		server.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
			if (!request.params?.cursor) return { tools: [pages[0]], nextCursor: "page2" };
			return { tools: [pages[1]] };
		});
		server.server.setRequestHandler(CallToolRequestSchema, async (request) => ({
			content: [{ type: "text", text: `called ${request.params.name}` }],
		}));
	}

	return server;
}

if (process.argv.includes("--http")) {
	// Stateless mode (sessionIdGenerator: undefined) — one transport per
	// request is simplest for a test fixture, no session bookkeeping needed.
	const httpServer = createServer(async (req, res) => {
		lastAuthHeader = req.headers["x-test-token"] ?? "none";
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		const server = buildServer();
		await server.connect(transport);
		await transport.handleRequest(req, res);
	});
	httpServer.listen(0, "127.0.0.1", () => {
		console.log(`LISTENING ${httpServer.address().port}`);
	});
} else {
	await buildServer().connect(new StdioServerTransport());
}
