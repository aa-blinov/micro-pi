/**
 * Web server — node:http, static files, REST API, SSE, HTTP Basic Auth.
 * Zero npm dependencies. The browser's own credential prompt (and its
 * password manager) does the work — no bespoke login page or session cookie
 * to build and keep in sync with it.
 */

import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { toDisplayMessages, type WebBridge, type WebEvent } from "./bridge.ts";
import { SLASH_COMMANDS } from "./commands.ts";

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".json": "application/json",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
};

export interface WebServerOptions {
	port: number;
	bridge: WebBridge;
	webUser: string;
	webPassword: string;
}

export function startWebServer(options: WebServerOptions): ReturnType<typeof createServer> {
	const { port, bridge, webUser, webPassword } = options;
	const publicDir = join(import.meta.dirname ?? ".", "public");

	console.log(`[cast web] auth enabled (user: ${webUser})`);

	function checkBasicAuth(req: IncomingMessage): boolean {
		const header = req.headers.authorization ?? "";
		if (!header.startsWith("Basic ")) return false;
		let decoded: string;
		try {
			decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
		} catch {
			return false;
		}
		const sep = decoded.indexOf(":");
		if (sep === -1) return false;
		return decoded.slice(0, sep) === webUser && decoded.slice(sep + 1) === webPassword;
	}

	function requireAuth(res: ServerResponse): void {
		res.writeHead(401, {
			"WWW-Authenticate": 'Basic realm="cast web", charset="UTF-8"',
			"Content-Type": "text/plain",
		});
		res.end("Authentication required");
	}

	// Helpers
	function json(res: ServerResponse, data: unknown, status = 200): void {
		const body = JSON.stringify(data);
		res.writeHead(status, {
			"Content-Type": "application/json",
			"Content-Length": Buffer.byteLength(body),
		});
		res.end(body);
	}

	function readBody(req: IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
			req.on("error", reject);
		});
	}

	function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
		let urlPath = req.url?.split("?")[0] ?? "/";
		if (urlPath === "/") urlPath = "/index.html";

		const filePath = join(publicDir, urlPath);
		// Prevent directory traversal
		if (!filePath.startsWith(publicDir)) {
			res.writeHead(403);
			res.end("Forbidden");
			return true;
		}

		try {
			const stat = statSync(filePath);
			if (!stat.isFile()) return false;
			const ext = extname(filePath);
			const mime = MIME_TYPES[ext] ?? "application/octet-stream";
			const content = readFileSync(filePath);
			res.writeHead(200, {
				"Content-Type": mime,
				"Content-Length": content.length,
				"Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
			});
			res.end(content);
			return true;
		} catch {
			return false;
		}
	}

	// Route matching
	type RouteHandler = (
		req: IncomingMessage,
		res: ServerResponse,
		params: Record<string, string>,
	) => void | Promise<void>;

	interface Route {
		method: string;
		pattern: RegExp;
		paramNames: string[];
		handler: RouteHandler;
	}

	const routes: Route[] = [];

	function route(method: string, path: string, handler: RouteHandler): void {
		const paramNames: string[] = [];
		const pattern = path.replace(/:(\w+)/g, (_match, name) => {
			paramNames.push(name);
			return "([^/]+)";
		});
		routes.push({ method, pattern: new RegExp(`^${pattern}$`), paramNames, handler });
	}

	function matchRoute(
		method: string,
		urlPath: string,
	): { handler: RouteHandler; params: Record<string, string> } | null {
		for (const r of routes) {
			if (r.method !== method) continue;
			const match = r.pattern.exec(urlPath);
			if (!match) continue;
			const params: Record<string, string> = {};
			r.paramNames.forEach((name, i) => {
				params[name] = match[i + 1]!;
			});
			return { handler: r.handler, params };
		}
		return null;
	}

	// API routes
	route("GET", "/api/personas", (_req, res) => {
		json(res, bridge.getPersonas());
	});

	route("GET", "/api/sessions", (_req, res) => {
		json(res, bridge.listSessions());
	});

	route("POST", "/api/sessions", async (req, res) => {
		const body = await readBody(req);
		let persona: string | undefined;
		let model: string | undefined;
		let cwd: string | undefined;
		try {
			const parsed = JSON.parse(body) as { persona?: string; model?: string; cwd?: string };
			persona = parsed.persona;
			model = parsed.model;
			cwd = parsed.cwd;
		} catch {
			// empty body is fine
		}
		const ws = bridge.createSession(persona, model, cwd);
		json(res, { id: ws.id, session: ws.session }, 201);
	});

	route("GET", "/api/sessions/:id", (_req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);
		json(res, {
			id: ws.id,
			persona: ws.session.persona,
			model: ws.session.model,
			cwd: ws.session.cwd,
			mode: ws.session.mode ?? "build",
			title: ws.session.title,
			pinned: ws.session.pinned,
			status: ws.status,
			messages: toDisplayMessages(ws.session.messages, ws.session.reasoning),
			usage: ws.session.usage,
			createdAt: ws.session.createdAt,
			updatedAt: ws.session.updatedAt,
		});
	});

	route("DELETE", "/api/sessions/:id", (_req, res, params) => {
		const closed = bridge.closeSession(params.id);
		if (!closed) return json(res, { error: "Not found" }, 404);
		json(res, { ok: true });
	});

	route("POST", "/api/sessions/:id/rename", async (req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);
		const body = await readBody(req);
		let title: string;
		try {
			const parsed = JSON.parse(body) as { title?: string };
			title = parsed.title ?? "";
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		bridge.renameSession(params.id, title);
		json(res, { ok: true, title: ws.session.title });
	});

	route("POST", "/api/sessions/:id/pin", async (req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);
		const body = await readBody(req);
		let pinned: boolean;
		try {
			const parsed = JSON.parse(body) as { pinned?: boolean };
			pinned = Boolean(parsed.pinned);
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		bridge.pinSession(params.id, pinned);
		json(res, { ok: true, pinned: Boolean(ws.session.pinned) });
	});

	route("POST", "/api/sessions/:id/chat", async (req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);
		const body = await readBody(req);
		let text: string;
		try {
			const parsed = JSON.parse(body) as { text?: string };
			text = parsed.text ?? "";
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		if (!text.trim()) return json(res, { error: "Empty message" }, 400);
		bridge.submit(params.id, text);
		json(res, { ok: true }, 202);
	});

	route("POST", "/api/sessions/:id/abort", (_req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);
		bridge.abort(params.id);
		json(res, { ok: true });
	});

	route("POST", "/api/sessions/:id/command", async (req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);
		const body = await readBody(req);
		let command: string;
		try {
			const parsed = JSON.parse(body) as { command?: string };
			command = parsed.command ?? "";
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		const result = await bridge.executeCommand(params.id, command);
		if (!result.ok) {
			const status = result.error?.includes("Agent running") ? 409 : 400;
			return json(res, { error: result.error }, status);
		}
		json(res, { ok: true, result: result.result });
	});

	route("GET", "/api/sessions/:id/events", (req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});

		// Send current status immediately
		res.write(`data: ${JSON.stringify({ type: "status", status: ws.status })}\n\n`);

		const listener = (event: WebEvent) => {
			try {
				res.write(`data: ${JSON.stringify(event)}\n\n`);
				// The session is gone from the bridge's map by the time this fires —
				// nothing left to unsubscribe from, just end the stream so the
				// client's EventSource doesn't spend its retry budget on a 404.
				if (event.type === "session_closed") res.end();
			} catch {
				// Client disconnected
				bridge.unsubscribe(params.id, listener);
			}
		};
		bridge.subscribe(params.id, listener);

		// Heartbeat
		const heartbeat = setInterval(() => {
			try {
				res.write(": keepalive\n\n");
			} catch {
				clearInterval(heartbeat);
				bridge.unsubscribe(params.id, listener);
			}
		}, 15_000);

		req.on("close", () => {
			clearInterval(heartbeat);
			bridge.unsubscribe(params.id, listener);
		});
	});

	route("GET", "/api/sessions/:id/diff", (req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);

		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const file = url.searchParams.get("file");
		const staged = url.searchParams.get("staged") === "true";
		const targetCwd = ws.session.cwd ?? process.cwd();

		// Checked separately, before running the real diff: a plain `git diff`
		// outside any repo doesn't fail with a clean "not a git repository"
		// message — it dumps git's entire `--no-index` usage text (hundreds of
		// lines) as the error, which is useless to show a user. This gives a
		// dedicated, unambiguous signal the client can render as an actual
		// instruction instead of a wall of git help text or a misleading
		// "No changes".
		try {
			execSync("git rev-parse --is-inside-work-tree", {
				cwd: targetCwd,
				encoding: "utf-8",
				timeout: 5_000,
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			return json(res, { files: [], noRepo: true });
		}

		try {
			const args = ["git", "diff", "--no-color", "--unified=3"];
			if (staged) args.push("--staged");
			if (file) args.push("--", file);
			const output = execSync(args.join(" "), {
				cwd: targetCwd,
				encoding: "utf-8",
				timeout: 10_000,
				maxBuffer: 5 * 1024 * 1024,
			});
			const parsed = parseDiff(output);
			json(res, parsed);
		} catch (err) {
			json(res, { files: [], error: err instanceof Error ? err.message : String(err) });
		}
	});

	// Read-only directory listing for the "new session" working-directory
	// picker — no narrower than what a session can already do with the bash
	// tool once it exists, so gating it behind the same Basic Auth as
	// everything else (rather than a separate allowed-root) is consistent
	// with the rest of this API's trust boundary.
	route("GET", "/api/browse", (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const requested = url.searchParams.get("path");
		const target = resolve(requested || bridge.getConfig().cwd || homedir());
		try {
			const st = statSync(target);
			if (!st.isDirectory()) throw new Error("Not a directory");
			const entries = readdirSync(target, { withFileTypes: true })
				.filter((e) => e.isDirectory() && !e.name.startsWith("."))
				.map((e) => e.name)
				.sort((a, b) => a.localeCompare(b))
				.map((name) => ({ name, path: join(target, name) }));
			const parent = dirname(target) === target ? null : dirname(target);
			json(res, { path: target, parent, entries });
		} catch (err) {
			json(res, {
				path: target,
				parent: dirname(target) === target ? null : dirname(target),
				entries: [],
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	route("GET", "/api/config", (_req, res) => {
		json(res, bridge.getConfig());
	});

	route("GET", "/api/commands", (_req, res) => {
		json(res, SLASH_COMMANDS);
	});

	route("GET", "/api/themes", (_req, res) => {
		json(res, bridge.getThemes());
	});

	route("GET", "/api/models", async (_req, res) => {
		json(res, await bridge.getModels());
	});

	route("GET", "/api/sessions/:id/reasoning-options", (_req, res, params) => {
		if (!bridge.getSession(params.id)) return json(res, { error: "Not found" }, 404);
		json(res, bridge.getReasoningOptionsForSession(params.id));
	});

	route("GET", "/api/suggest", (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const input = url.searchParams.get("q") ?? "";
		const sessionId = url.searchParams.get("session") ?? "";
		json(res, bridge.suggestCommand(sessionId, input));
	});
	// Main request handler
	const server = createServer(async (req, res) => {
		const urlPath = req.url?.split("?")[0] ?? "/";
		const method = req.method ?? "GET";

		if (!checkBasicAuth(req)) {
			requireAuth(res);
			return;
		}

		// API routes
		const matched = matchRoute(method, urlPath);
		if (matched) {
			try {
				await matched.handler(req, res, matched.params);
			} catch (err) {
				console.error(`[cast web] ${method} ${urlPath}:`, err);
				if (!res.headersSent) {
					json(res, { error: "Internal server error" }, 500);
				}
			}
			return;
		}

		// Static files (fallback)
		if (method === "GET") {
			if (serveStatic(req, res)) return;
		}

		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("Not found");
	});

	server.listen(port, "0.0.0.0", () => {
		console.log(`[cast web] listening on http://0.0.0.0:${port}`);
	});

	return server;
}

// ── Diff parsing ──

interface DiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: Array<{ type: "+" | "-" | " "; content: string }>;
}

interface DiffFile {
	path: string;
	oldPath?: string;
	hunks: DiffHunk[];
	additions: number;
	deletions: number;
}

function parseDiff(raw: string): { files: DiffFile[] } {
	const files: DiffFile[] = [];
	let currentFile: DiffFile | null = null;
	let currentHunk: DiffHunk | null = null;

	for (const line of raw.split("\n")) {
		if (line.startsWith("diff --git")) {
			const match = /b\/(.+)$/.exec(line);
			currentFile = {
				path: match?.[1] ?? "unknown",
				hunks: [],
				additions: 0,
				deletions: 0,
			};
			files.push(currentFile);
			currentHunk = null;
			continue;
		}

		if (!currentFile) continue;

		if (line.startsWith("--- a/")) {
			currentFile.oldPath = line.slice(6);
			continue;
		}
		if (line.startsWith("--- /dev/null")) {
			currentFile.oldPath = undefined;
			continue;
		}
		if (line.startsWith("+++") || line.startsWith("---")) continue;

		const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (hunkMatch) {
			currentHunk = {
				oldStart: parseInt(hunkMatch[1]!, 10),
				oldLines: parseInt(hunkMatch[2] ?? "1", 10),
				newStart: parseInt(hunkMatch[3]!, 10),
				newLines: parseInt(hunkMatch[4] ?? "1", 10),
				lines: [],
			};
			currentFile.hunks.push(currentHunk);
			continue;
		}

		if (!currentHunk) continue;

		if (line.startsWith("+")) {
			currentHunk.lines.push({ type: "+", content: line.slice(1) });
			currentFile.additions++;
		} else if (line.startsWith("-")) {
			currentHunk.lines.push({ type: "-", content: line.slice(1) });
			currentFile.deletions++;
		} else {
			currentHunk.lines.push({ type: " ", content: line.startsWith(" ") ? line.slice(1) : line });
		}
	}

	return { files };
}
