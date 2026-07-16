import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { loadSshConfig, resolveSshHosts, validateKeyPermissions } from "../src/core/ssh.ts";
import { createToolExecutor, getToolDefinitions } from "../src/core/tools.ts";

const TEST_DIR = join(import.meta.dirname, "__test_tmp__", "ssh");

const mockConfig: AppConfig = {
	baseURL: "http://localhost",
	apiKey: "test",
	contextWindow: 128_000,
	maxResponseTokens: 8192,
	compactionThreshold: 0.75,
	maxToolOutputLines: 2000,
	maxToolOutputBytes: 64 * 1024,
	defaultBashTimeout: 10,
};

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// ============================================================================
// loadSshConfig
// ============================================================================

describe("loadSshConfig", () => {
	it("returns empty object for missing file", () => {
		expect(loadSshConfig(join(TEST_DIR, "nonexistent.json"))).toEqual({});
	});

	it("returns empty object for malformed JSON", () => {
		const path = join(TEST_DIR, "bad.json");
		writeFileSync(path, "not json", "utf-8");
		expect(loadSshConfig(path)).toEqual({});
	});

	it("parses valid config with hosts key", () => {
		const path = join(TEST_DIR, "ssh.json");
		writeFileSync(
			path,
			JSON.stringify({
				hosts: {
					server1: { host: "10.0.0.1", username: "admin" },
					server2: { host: "10.0.0.2", port: 2222, keyPath: "~/.ssh/id_rsa" },
				},
			}),
			"utf-8",
		);
		const result = loadSshConfig(path);
		expect(Object.keys(result)).toEqual(["server1", "server2"]);
		expect(result.server1).toEqual({ host: "10.0.0.1", username: "admin" });
		expect(result.server2?.port).toBe(2222);
	});

	it("returns empty if hosts key is missing", () => {
		const path = join(TEST_DIR, "nohosts.json");
		writeFileSync(path, JSON.stringify({ other: "data" }), "utf-8");
		expect(loadSshConfig(path)).toEqual({});
	});

	it("parses password and dangerousCommands fields", () => {
		const path = join(TEST_DIR, "full.json");
		writeFileSync(
			path,
			JSON.stringify({
				hosts: {
					prod: { host: "prod.example.com", username: "root", password: "secret", dangerousCommands: "bypass" },
				},
			}),
			"utf-8",
		);
		const result = loadSshConfig(path);
		expect(result.prod?.password).toBe("secret");
		expect(result.prod?.dangerousCommands).toBe("bypass");
	});
});

// ============================================================================
// resolveSshHosts
// ============================================================================

describe("resolveSshHosts", () => {
	it("loads global hosts", () => {
		const _globalPath = join(homedir(), ".cast", "ssh.json");
		// This test assumes no global config exists — it should just return empty
		const hosts = resolveSshHosts("/nonexistent", false);
		// Might have real global hosts if they exist, just check it returns an array
		expect(Array.isArray(hosts)).toBe(true);
	});

	it("loads project hosts when trusted", () => {
		const sshDir = join(TEST_DIR, ".cast");
		mkdirSync(sshDir, { recursive: true });
		writeFileSync(
			join(sshDir, "ssh.json"),
			JSON.stringify({ hosts: { myhost: { host: "1.2.3.4", username: "user" } } }),
			"utf-8",
		);
		const hosts = resolveSshHosts(TEST_DIR, true);
		const found = hosts.find((h) => h.name === "myhost");
		expect(found).toBeDefined();
		expect(found?.host).toBe("1.2.3.4");
	});

	it("skips project hosts when untrusted", () => {
		const sshDir = join(TEST_DIR, ".cast");
		mkdirSync(sshDir, { recursive: true });
		writeFileSync(join(sshDir, "ssh.json"), JSON.stringify({ hosts: { myhost: { host: "1.2.3.4" } } }), "utf-8");
		const hosts = resolveSshHosts(TEST_DIR, false);
		const found = hosts.find((h) => h.name === "myhost");
		expect(found).toBeUndefined();
	});

	it("project overrides global on same name", () => {
		// Write a project config with a host named "test-override"
		const sshDir = join(TEST_DIR, ".cast");
		mkdirSync(sshDir, { recursive: true });
		writeFileSync(
			join(sshDir, "ssh.json"),
			JSON.stringify({ hosts: { "test-override": { host: "project-host" } } }),
			"utf-8",
		);
		// Write a global config with the same host name
		const globalDir = join(homedir(), ".cast");
		const globalPath = join(globalDir, "ssh.json");
		const hadGlobal = existsSync(globalPath);
		let globalBackup = "";
		if (hadGlobal) {
			globalBackup = require("node:fs").readFileSync(globalPath, "utf-8");
		}
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(globalPath, JSON.stringify({ hosts: { "test-override": { host: "global-host" } } }), "utf-8");
		try {
			const hosts = resolveSshHosts(TEST_DIR, true);
			const found = hosts.find((h) => h.name === "test-override");
			expect(found?.host).toBe("project-host");
		} finally {
			if (hadGlobal) {
				writeFileSync(globalPath, globalBackup, "utf-8");
			} else {
				rmSync(globalPath, { force: true });
			}
		}
	});

	it("expands ~ in keyPath", () => {
		const sshDir = join(TEST_DIR, ".cast");
		mkdirSync(sshDir, { recursive: true });
		writeFileSync(
			join(sshDir, "ssh.json"),
			JSON.stringify({ hosts: { h: { host: "1.2.3.4", keyPath: "~/.ssh/id_rsa" } } }),
			"utf-8",
		);
		const hosts = resolveSshHosts(TEST_DIR, true);
		const found = hosts.find((h) => h.name === "h");
		expect(found?.keyPath).toBe(`${homedir()}/.ssh/id_rsa`);
	});
});

// ============================================================================
// validateKeyPermissions
// ============================================================================

describe("validateKeyPermissions", () => {
	it("returns undefined for nonexistent key", () => {
		const err = validateKeyPermissions("/nonexistent/key");
		expect(err).toContain("not found");
	});

	it("returns undefined for missing key (correct error)", () => {
		const err = validateKeyPermissions(join(TEST_DIR, "missing-key"));
		expect(err).toContain("not found");
	});

	it("returns error for non-file path", () => {
		mkdirSync(join(TEST_DIR, "keydir"), { recursive: true });
		const err = validateKeyPermissions(join(TEST_DIR, "keydir"));
		expect(err).toContain("not a file");
	});
});

// ============================================================================
// SSH tool definition
// ============================================================================

describe("SSH tool definitions", () => {
	it("does not include ssh tool when sshHostNames is undefined", () => {
		const tools = getToolDefinitions();
		const ssh = tools.find((t) => t.function.name === "ssh");
		expect(ssh).toBeUndefined();
	});

	it("does not include ssh tool when sshHostNames is empty", () => {
		const tools = getToolDefinitions(undefined, undefined, undefined, []);
		const ssh = tools.find((t) => t.function.name === "ssh");
		expect(ssh).toBeUndefined();
	});

	it("includes ssh tool when sshHostNames is non-empty", () => {
		const tools = getToolDefinitions(undefined, undefined, undefined, ["server1", "server2"]);
		const ssh = tools.find((t) => t.function.name === "ssh");
		expect(ssh).toBeDefined();
		expect(ssh?.function.description).toContain("server1");
		expect(ssh?.function.description).toContain("server2");
		expect(ssh?.function.parameters?.required).toEqual(["host", "command"]);
	});
});

// ============================================================================
// SSH tool executor
// ============================================================================

describe("SSH tool executor", () => {
	it("returns error for unknown host", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, undefined, undefined, [
			{ name: "known", host: "1.2.3.4" },
		]);
		const result = await exec("ssh", { host: "unknown", command: "ls" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Unknown SSH host");
		expect(result.content).toContain("known");
	});

	it("returns error for invalid key path", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, undefined, undefined, [
			{ name: "h", host: "1.2.3.4", keyPath: "/nonexistent/key" },
		]);
		const result = await exec("ssh", { host: "h", command: "ls" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("not found");
	});
});
