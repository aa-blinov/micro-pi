import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	closeMcpConnections,
	connectMcpServers,
	loadMcpConfig,
	mcpToolName,
	sanitizeToolNamePart,
} from "../src/core/mcp.ts";

const TEST_DIR = join(import.meta.dirname, "__mcp_test_tmp__");
const FIXTURE_SERVER = join(import.meta.dirname, "fixtures", "mcp-echo-server.mjs");

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("sanitizeToolNamePart / mcpToolName", () => {
	it("passes through already-safe names", () => {
		expect(sanitizeToolNamePart("filesystem")).toBe("filesystem");
	});

	it("replaces unsafe characters with underscores", () => {
		expect(sanitizeToolNamePart("my server.v2!")).toBe("my_server_v2_");
	});

	it("namespaces a tool name under its server", () => {
		expect(mcpToolName("filesystem", "read_file")).toBe("mcp_filesystem_read_file");
	});
});

describe("loadMcpConfig", () => {
	it("returns an empty object for a missing file", () => {
		mkdirSync(TEST_DIR, { recursive: true });
		expect(loadMcpConfig(join(TEST_DIR, "does-not-exist.json"))).toEqual({});
	});

	it("returns an empty object for malformed JSON instead of throwing", () => {
		mkdirSync(TEST_DIR, { recursive: true });
		const path = join(TEST_DIR, "mcp.json");
		writeFileSync(path, "{ not valid json");
		expect(loadMcpConfig(path)).toEqual({});
	});

	it("returns an empty object when mcpServers is missing", () => {
		mkdirSync(TEST_DIR, { recursive: true });
		const path = join(TEST_DIR, "mcp.json");
		writeFileSync(path, JSON.stringify({ somethingElse: true }));
		expect(loadMcpConfig(path)).toEqual({});
	});

	it("parses a valid mcpServers config", () => {
		mkdirSync(TEST_DIR, { recursive: true });
		const path = join(TEST_DIR, "mcp.json");
		writeFileSync(
			path,
			JSON.stringify({
				mcpServers: { echo: { command: "node", args: ["server.js"] } },
			}),
		);
		expect(loadMcpConfig(path)).toEqual({ echo: { command: "node", args: ["server.js"] } });
	});
});

describe("connectMcpServers (real spawned MCP server, not mocked)", () => {
	it("discovers tools and namespaces them under the server name", async () => {
		const result = await connectMcpServers({ echo: { command: "node", args: [FIXTURE_SERVER] } });
		try {
			expect(result.diagnostics).toEqual([]);
			expect(result.connections).toEqual([{ serverName: "echo", toolCount: 4, client: expect.anything() }]);
			expect([...result.toolIndex.keys()].sort()).toEqual([
				"mcp_echo_add",
				"mcp_echo_echo",
				"mcp_echo_fails",
				"mcp_echo_get-last-auth-header",
			]);
		} finally {
			await closeMcpConnections(result.connections);
		}
	});

	it("builds OpenAI-shape tool definitions from the server's inputSchema", async () => {
		const result = await connectMcpServers({ echo: { command: "node", args: [FIXTURE_SERVER] } });
		try {
			const echoDef = result.toolDefinitions.find((t) => t.function.name === "mcp_echo_echo");
			expect(echoDef?.type).toBe("function");
			expect(echoDef?.function.description).toContain("echo");
			expect(echoDef?.function.parameters).toMatchObject({ type: "object" });
		} finally {
			await closeMcpConnections(result.connections);
		}
	});

	it("round-trips an actual tool call through the real protocol", async () => {
		const result = await connectMcpServers({ echo: { command: "node", args: [FIXTURE_SERVER] } });
		try {
			const handle = result.toolIndex.get("mcp_echo_echo")!;
			const callResult = await handle.call({ text: "hello from a real MCP call" });
			expect(callResult).toEqual({ content: "hello from a real MCP call", isError: false, imageDataUrl: undefined });
		} finally {
			await closeMcpConnections(result.connections);
		}
	});

	it("computes tool results with multiple arguments correctly", async () => {
		const result = await connectMcpServers({ echo: { command: "node", args: [FIXTURE_SERVER] } });
		try {
			const handle = result.toolIndex.get("mcp_echo_add")!;
			const callResult = await handle.call({ a: 3, b: 4 });
			expect(callResult.content).toBe("7");
			expect(callResult.isError).toBe(false);
		} finally {
			await closeMcpConnections(result.connections);
		}
	});

	it("surfaces a tool-level error via isError, not a thrown exception", async () => {
		const result = await connectMcpServers({ echo: { command: "node", args: [FIXTURE_SERVER] } });
		try {
			const handle = result.toolIndex.get("mcp_echo_fails")!;
			const callResult = await handle.call({});
			expect(callResult.isError).toBe(true);
			expect(callResult.content).toContain("deliberate failure");
		} finally {
			await closeMcpConnections(result.connections);
		}
	});

	it("records a diagnostic instead of throwing when a server's command doesn't exist", async () => {
		const result = await connectMcpServers({ bad: { command: "this-command-does-not-exist-xyz" } });
		expect(result.connections).toEqual([]);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]).toContain("bad");
	});

	it("connects to multiple servers independently — one bad server doesn't block a good one", async () => {
		const result = await connectMcpServers({
			echo: { command: "node", args: [FIXTURE_SERVER] },
			bad: { command: "this-command-does-not-exist-xyz" },
		});
		try {
			expect(result.connections.map((c) => c.serverName)).toEqual(["echo"]);
			expect(result.diagnostics).toHaveLength(1);
			expect([...result.toolIndex.keys()].sort()).toEqual([
				"mcp_echo_add",
				"mcp_echo_echo",
				"mcp_echo_fails",
				"mcp_echo_get-last-auth-header",
			]);
		} finally {
			await closeMcpConnections(result.connections);
		}
	});

	it("gives a clear diagnostic when a server config has neither command nor url", async () => {
		const result = await connectMcpServers({ broken: {} });
		expect(result.connections).toEqual([]);
		expect(result.diagnostics).toEqual([
			'mcp server "broken": needs either "command" (local) or "url" (remote) in its config',
		]);
	});

	it("follows nextCursor to collect tools across multiple tools/list pages", async () => {
		const result = await connectMcpServers({ echo: { command: "node", args: [FIXTURE_SERVER, "--paginate"] } });
		try {
			expect(result.diagnostics).toEqual([]);
			expect([...result.toolIndex.keys()].sort()).toEqual(["mcp_echo_page-a", "mcp_echo_page-b"]);
			const callResult = await result.toolIndex.get("mcp_echo_page-b")!.call({});
			expect(callResult).toEqual({ content: "called page-b", isError: false, imageDataUrl: undefined });
		} finally {
			await closeMcpConnections(result.connections);
		}
	});

	it("translates every MCP content-block type instead of dropping non-text/first-image parts", async () => {
		const result = await connectMcpServers({ echo: { command: "node", args: [FIXTURE_SERVER, "--rich"] } });
		try {
			const callResult = await result.toolIndex.get("mcp_echo_rich-content")!.call({});
			expect(callResult.isError).toBe(false);
			// first image becomes imageDataUrl, per the existing single-image ToolResult shape
			expect(callResult.imageDataUrl).toBe("data:image/png;base64,aGVsbG8=");
			// everything else is folded into content as readable text, not silently dropped
			expect(callResult.content).toContain("hello text");
			expect(callResult.content).toContain("[1 additional image(s) omitted]");
			expect(callResult.content).toContain("[audio content omitted: audio/wav]");
			expect(callResult.content).toContain(
				"[resource link: example.txt (file:///tmp/example.txt) — an example file]",
			);
			expect(callResult.content).toContain("inline resource text");
		} finally {
			await closeMcpConnections(result.connections);
		}
	});
});

describe("connectMcpServers (real remote/streamableHTTP MCP server, not mocked)", () => {
	let fixture: ChildProcessWithoutNullStreams;
	let url: string;

	beforeAll(async () => {
		fixture = spawn("node", [FIXTURE_SERVER, "--http"]);
		const port = await new Promise<number>((resolve, reject) => {
			let out = "";
			fixture.stdout.on("data", (chunk) => {
				out += chunk.toString();
				const match = out.match(/LISTENING (\d+)/);
				if (match) resolve(Number(match[1]));
			});
			fixture.on("error", reject);
			setTimeout(() => reject(new Error("fixture HTTP server didn't start in time")), 10_000);
		});
		url = `http://127.0.0.1:${port}/`;
	});

	afterAll(() => {
		fixture.kill();
	});

	it("connects over streamable HTTP and discovers tools", async () => {
		const result = await connectMcpServers({ echo: { url } });
		try {
			expect(result.diagnostics).toEqual([]);
			expect([...result.toolIndex.keys()].sort()).toEqual([
				"mcp_echo_add",
				"mcp_echo_echo",
				"mcp_echo_fails",
				"mcp_echo_get-last-auth-header",
			]);
		} finally {
			await closeMcpConnections(result.connections);
		}
	});

	it("round-trips an actual tool call over the real protocol", async () => {
		const result = await connectMcpServers({ echo: { url } });
		try {
			const callResult = await result.toolIndex.get("mcp_echo_echo")!.call({ text: "hello over http" });
			expect(callResult).toEqual({ content: "hello over http", isError: false, imageDataUrl: undefined });
		} finally {
			await closeMcpConnections(result.connections);
		}
	});

	it("sends configured headers on the wire — verified through connectMcpServers itself, not a manual fetch", async () => {
		const result = await connectMcpServers({ echo: { url, headers: { "X-Test-Token": "secret123" } } });
		try {
			// The connection handshake itself is a real HTTP request carrying
			// the configured headers, so by the time we can call a tool at all,
			// the fixture has already recorded what it saw.
			const callResult = await result.toolIndex.get("mcp_echo_get-last-auth-header")!.call({});
			expect(callResult.content).toBe("secret123");
		} finally {
			await closeMcpConnections(result.connections);
		}
	});

	it("omits the header when the server config doesn't specify one", async () => {
		const result = await connectMcpServers({ echo: { url } });
		try {
			const callResult = await result.toolIndex.get("mcp_echo_get-last-auth-header")!.call({});
			expect(callResult.content).toBe("none");
		} finally {
			await closeMcpConnections(result.connections);
		}
	});
});
