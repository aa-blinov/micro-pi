import { describe, expect, it } from "vitest";
import type { Tool } from "../src/core/llm.ts";
import { formatMcpForPrompt, type McpSetupResult } from "../src/core/mcp.ts";

function makeResult(
	connections: { serverName: string; toolCount: number }[],
	tools: { name: string; description: string }[],
): McpSetupResult {
	return {
		connections: connections as McpSetupResult["connections"],
		toolDefinitions: tools.map((t) => ({
			type: "function" as const,
			function: { name: t.name, description: t.description, parameters: {} },
		})) as Tool[],
		toolIndex: new Map(),
		diagnostics: [],
		allServerNames: connections.map((c) => c.serverName),
	};
}

describe("formatMcpForPrompt", () => {
	it("returns empty string when no connections", () => {
		const result = makeResult([], []);
		expect(formatMcpForPrompt(result)).toBe("");
	});

	it("formats connected servers with their tools", () => {
		const result = makeResult(
			[{ serverName: "context7", toolCount: 2 }],
			[
				{ name: "mcp_context7_resolve-library-id", description: "[context7] Resolve a library ID" },
				{ name: "mcp_context7_query-docs", description: "[context7] Query documentation" },
			],
		);
		const output = formatMcpForPrompt(result);
		expect(output).toContain("<available_mcp>");
		expect(output).toContain("</available_mcp>");
		expect(output).toContain("Only enabled MCP servers");
		expect(output).toContain('name="context7"');
		expect(output).toContain("mcp_context7_resolve-library-id");
		expect(output).toContain("mcp_context7_query-docs");
	});

	it("includes multiple servers", () => {
		const result = makeResult(
			[
				{ serverName: "context7", toolCount: 1 },
				{ serverName: "github", toolCount: 1 },
			],
			[
				{ name: "mcp_context7_query-docs", description: "[context7] Query docs" },
				{ name: "mcp_github_create-issue", description: "[github] Create issue" },
			],
		);
		const output = formatMcpForPrompt(result);
		expect(output).toContain('name="context7"');
		expect(output).toContain('name="github"');
	});

	it("excludes tools from other servers", () => {
		const result = makeResult(
			[{ serverName: "context7", toolCount: 1 }],
			[
				{ name: "mcp_context7_query-docs", description: "[context7] Query docs" },
				{ name: "mcp_github_create-issue", description: "[github] Create issue" },
			],
		);
		const output = formatMcpForPrompt(result);
		expect(output).toContain("mcp_context7_query-docs");
		expect(output).not.toContain("mcp_github_create-issue");
	});
});
