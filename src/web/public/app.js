/**
 * cast web — Preact + htm client application.
 * No build step: importmap loads preact and htm from esm.sh CDN.
 */

import htm from "htm";
import { h, render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { icons } from "./icons.js";

const html = htm.bind(h);

// Same ASCII mark as the CLI's startup banner (see core/help.ts's CAST_BANNER) —
// kept as an array-of-lines join here too, since the backslashes need to stay
// literal and a template literal would make that harder to read at a glance.
const CAST_BANNER = [
	" ░▒▓██████▓▒░ ░▒▓██████▓▒░ ░▒▓███████▓▒░▒▓████████▓▒░",
	"░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░         ░▒▓█▓▒░    ",
	"░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░         ░▒▓█▓▒░    ",
	"░▒▓█▓▒░      ░▒▓████████▓▒░░▒▓██████▓▒░   ░▒▓█▓▒░    ",
	"░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░      ░▒▓█▓▒░  ░▒▓█▓▒░    ",
	"░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░      ░▒▓█▓▒░  ░▒▓█▓▒░    ",
	" ░▒▓██████▓▒░░▒▓█▓▒░░▒▓█▓▒░▒▓███████▓▒░   ░▒▓█▓▒░    ",
].join("\n");

const isMac =
	typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
const modKeys = isMac ? ["⌘"] : ["Ctrl"];
const modShiftKeys = isMac ? ["⌘", "⇧"] : ["Ctrl", "Shift"];
const modKey = modKeys.join("");
// kc() renders each key of a shortcut as its own key-cap chip instead of
// one flat text/ASCII string, so multi-key combos read like a keyboard.
const kc = (...keys) => keys.map((k) => `<kbd class="hotkey-key">${k}</kbd>`).join("");

const hotkeysHtml = `
	<div class="hotkey-group">
		<div class="hotkey-group-title">General</div>
		<div class="hotkey-row"><span class="hotkey-label">Toggle sidebar</span><span class="hotkey-keys">${kc(...modKeys, "B")}</span></div>
		<div class="hotkey-row"><span class="hotkey-label">Toggle diff</span><span class="hotkey-keys">${kc(...modShiftKeys, "D")}</span></div>
		<div class="hotkey-row"><span class="hotkey-label">New session</span><span class="hotkey-keys">${kc(...modShiftKeys, "N")}</span></div>
		<div class="hotkey-row"><span class="hotkey-label">Clear context</span><span class="hotkey-keys">${kc(...modShiftKeys, "L")}</span></div>
		<div class="hotkey-row"><span class="hotkey-label">Show shortcuts</span><span class="hotkey-keys">${kc(...modKeys, "/")}</span></div>
	</div>
	<div class="hotkey-group">
		<div class="hotkey-group-title">Composer</div>
		<div class="hotkey-row"><span class="hotkey-label">Send message</span><span class="hotkey-keys">${kc("↵")}</span></div>
		<div class="hotkey-row"><span class="hotkey-label">New line</span><span class="hotkey-keys">${kc("⇧", "↵")}</span></div>
		<div class="hotkey-row"><span class="hotkey-label">Abort run</span><span class="hotkey-keys">${kc("Esc")}</span></div>
		<div class="hotkey-row"><span class="hotkey-label">Navigate suggestions</span><span class="hotkey-keys">${kc("↑", "↓")}</span></div>
	</div>
`;

// ── API ──────────────────────────────────────────────────────────────
async function api(method, path, body) {
	const opts = { method, headers: {} };
	if (body !== undefined) {
		opts.headers["Content-Type"] = "application/json";
		opts.body = JSON.stringify(body);
	}
	const res = await fetch(`${window.location.origin}${path}`, opts);
	if (res.status === 401) {
		// The browser normally attaches cached HTTP Basic Auth credentials to
		// every request automatically — a 401 here means they were rejected
		// (e.g. the password changed on disk). Reload to re-trigger the
		// browser's native credential prompt.
		window.location.reload();
		return null;
	}
	const data = await res.json().catch(() => null);
	if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
	return data;
}

// ── Theme ────────────────────────────────────────────────────────────
// Only accent colors are themed (16 palettes, shared with the TUI via
// settings.json's `theme` field) — background/border/text neutrals stay
// fixed so the "terminal control room" look holds regardless of palette.
function applyTheme(colors) {
	if (!colors) return;
	const root = document.documentElement.style;
	root.setProperty("--cyan", colors.accent);
	root.setProperty("--violet", colors.gradient.to);
	root.setProperty("--gradient", `linear-gradient(135deg, ${colors.gradient.from}, ${colors.gradient.to})`);
	root.setProperty("--teal", colors.user);
	root.setProperty("--purple", colors.agent);
	root.setProperty("--blue", colors.tool);
	root.setProperty("--green", colors.success);
	root.setProperty("--amber", colors.warning);
	root.setProperty("--rose", colors.error);
	root.setProperty("--persona", colors.persona);
	root.setProperty("--text-muted", colors.muted);
}

// ── Helpers ──────────────────────────────────────────────────────────
function escapeHtml(s) {
	if (!s) return "";
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMarkdown(text) {
	if (!text) return "";

	// Pull fenced code blocks out first so inline rules below can't mangle
	// their contents; they go back in verbatim (already escaped) at the end.
	const fences = [];
	const src = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
		const i = fences.length;
		const label = lang ? `<div class="code-lang">${escapeHtml(lang)}</div>` : "";
		fences.push(`<pre>${label}<code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
		return ` FENCE${i} `;
	});

	let out = escapeHtml(src);
	out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
	out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
	out = out.replace(/^#{1,6} (.+)$/gm, "<strong>$1</strong>");

	// Group consecutive list lines into a single <ul>/<ol>.
	out = out.replace(/(?:^[ \t]*[-*] .+$\n?)+/gm, (block) => {
		const items = block
			.trim()
			.split("\n")
			.map((l) => `<li>${l.replace(/^[ \t]*[-*] /, "")}</li>`)
			.join("");
		return `<ul>${items}</ul>\n`;
	});
	out = out.replace(/(?:^[ \t]*\d+\. .+$\n?)+/gm, (block) => {
		const items = block
			.trim()
			.split("\n")
			.map((l) => `<li>${l.replace(/^[ \t]*\d+\. /, "")}</li>`)
			.join("");
		return `<ol>${items}</ol>\n`;
	});

	out = out.replace(/ FENCE(\d+) /g, (_m, i) => fences[Number(i)]);
	return out;
}

// Recursively renders a parsed arg value as indented "key: value" lines.
// Plain JSON.stringify on nested objects (the previous approach) escapes any
// newline inside a nested string as a literal two-character "\n" — exactly
// the shape of the `edit` tool's args (ops: [{ content: "<multi-line code>" }]),
// so that turned into an unreadable wall of "\n"/"\t" text. Recursing instead
// of stringifying keeps every string's real line breaks intact at any depth.
function formatValue(v, indent) {
	if (typeof v === "string") return v;
	if (Array.isArray(v)) {
		return v.map((item, i) => `${indent}[${i}]\n${formatValue(item, `${indent}  `)}`).join("\n");
	}
	if (v && typeof v === "object") {
		return Object.entries(v)
			.map(([k, val]) => {
				const formatted = formatValue(val, `${indent}  `);
				return formatted.includes("\n") ? `${indent}${k}:\n${formatted}` : `${indent}${k}: ${formatted}`;
			})
			.join("\n");
	}
	return `${indent}${JSON.stringify(v)}`;
}

// Full parameter dump, not a truncated hint — the point is to see exactly
// what the agent is about to run, not just enough to guess.
function formatArgsFull(args) {
	if (!args) return "";
	try {
		const obj = JSON.parse(args);
		const entries = Object.entries(obj);
		if (entries.length === 0) return "";
		return entries
			.map(([k, v]) => {
				const formatted = typeof v === "string" ? v : formatValue(v, "  ");
				return formatted.includes("\n") ? `${k}:\n${formatted}` : `${k}: ${formatted}`;
			})
			.join("\n");
	} catch {
		return args;
	}
}

function shortPath(p) {
	if (!p) return "";
	const parts = p.split("/").filter(Boolean);
	if (parts.length <= 2) return p;
	return `…/${parts.slice(-2).join("/")}`;
}

const _WEB_TOOLS_OPTIONS = [
	{ value: "on", label: "Enable" },
	{ value: "off", label: "Disable" },
];

// ── URL routing ──────────────────────────────────────────────────────
// A query param, not a path segment (`/s/:id`) — the server's static file
// route only knows how to serve index.html for "/" itself, so anything path
// based would need a server-side change; "?session=" needs none, since the
// query string never affects which file gets served.
function sessionIdFromUrl() {
	return new URLSearchParams(window.location.search).get("session");
}
function setUrlSessionId(id, { push } = {}) {
	const url = `${window.location.pathname}?session=${encodeURIComponent(id)}`;
	if (push) window.history.pushState({ sessionId: id }, "", url);
	else window.history.replaceState({ sessionId: id }, "", url);
}

// ── Components ───────────────────────────────────────────────────────

// MCP tools are exposed to the model as "mcp_<server>_<tool>" (see
// core/mcp.ts's mcpToolName) — sanitized-and-joined with no reversible
// separator, so the server name can't be split back out exactly. Stripping
// the "mcp_" prefix and loosening the rest into "word · word" reads far
// better than the raw underscored blob without needing that split to be
// exact — this is a label only, the real name stays in `call.name`/data-tool.
function isMcpTool(name) {
	return name.startsWith("mcp_");
}
function mcpToolLabel(name) {
	return name.slice(4).replace(/_/g, " · ");
}

function ToolCard({ call }) {
	// Shows what the agent is calling — full input parameters — and whether
	// it's still running / succeeded / failed. Deliberately no result body:
	// the point of this card is the request, not the (often huge) output.
	const statusClass = call.status || "running";
	const args = formatArgsFull(call.args);
	const mcp = isMcpTool(call.name);
	return html`
		<div class="tool-card">
			<div class="tool-card-header" data-tool=${call.name}>
				${mcp && html`<span class="tool-card-mcp-badge">MCP</span>`}
				<span class="tool-card-name">${mcp ? mcpToolLabel(call.name) : call.name}</span>
				<span class="tool-card-status ${statusClass}" />
			</div>
			${args && html`<div class="tool-card-body">${args}</div>`}
		</div>
	`;
}

function Message({ msg }) {
	const role = msg.role || "assistant";
	if (role === "tool") return null;

	const labelMap = {
		user: "you",
		agent: "agent",
		assistant: "agent",
		system: "system",
		warning: "notice",
		error: "error",
	};

	// Messages flushed from a live turn this session carry the full ordered
	// block sequence (reasoning / prose / tool calls, same shape as
	// StreamingBlocks) instead of one flattened string — render each block
	// distinctly so reasoning doesn't silently blend into the reply, and so
	// every tool call this turn made stays visible after it settles.
	if (role === "assistant" && Array.isArray(msg.blocks)) {
		return html`
			<div class="message-group">
				${msg.blocks.map((block, i) => {
					if (block.kind === "tool") return html`<${ToolCard} key=${block.call.id} call=${block.call} />`;
					if (block.kind === "thinking") {
						if (!block.text.trim()) return null;
						return html`
							<div key=${i} class="message message-reasoning">
								<div class="message-label">reasoning</div>
								<div class="message-content">${block.text}</div>
							</div>
						`;
					}
					if (!block.text.trim()) return null;
					return html`
						<div key=${i} class="message message-assistant">
							<div class="message-label">agent</div>
							<div class="message-content" dangerouslySetInnerHTML=${{ __html: renderMarkdown(block.text) }} />
						</div>
					`;
				})}
			</div>
		`;
	}

	// content is `null` for a tool-call-only turn (see core/loop.ts) — treat
	// that as "no text", not the literal string "null" JSON.stringify gives it.
	const content =
		typeof msg.content === "string" ? msg.content : msg.content == null ? "" : JSON.stringify(msg.content);

	if (role === "assistant") {
		return html`
			<div class="message-group">
				${
					msg.thinking &&
					html`
					<div class="message message-reasoning">
						<div class="message-label">reasoning</div>
						<div class="message-content">${msg.thinking}</div>
					</div>
				`
				}
				${msg.toolCalls?.map((tc) => html`<${ToolCard} key=${tc.id} call=${tc} />`)}
				${
					content &&
					html`
					<div class="message message-assistant">
						<div class="message-label">agent</div>
						<div class="message-content" dangerouslySetInnerHTML=${{ __html: renderMarkdown(content) }} />
					</div>
				`
				}
			</div>
		`;
	}

	return html`
		<div class="message message-${role}">
			<div class="message-label">${labelMap[role] ?? role}</div>
			<div class="message-content" dangerouslySetInnerHTML=${{ __html: role === "user" ? escapeHtml(content) : renderMarkdown(content) }} />
		</div>
	`;
}

function StreamingBlocks({ blocks }) {
	if (!blocks || blocks.length === 0) return null;
	return html`
		<div>
			${blocks.map((block, i) => {
				if (block.kind === "content") {
					return html`<div key=${i} class="streaming-block">
						<div class="streaming-content streaming-cursor" dangerouslySetInnerHTML=${{ __html: renderMarkdown(block.text) }} />
					</div>`;
				}
				if (block.kind === "thinking") {
					return html`<div key=${i} class="streaming-block streaming-thinking">
						<div class="streaming-content">${block.text}</div>
					</div>`;
				}
				if (block.kind === "tool") {
					return html`<${ToolCard} key=${block.call.id} call=${block.call} />`;
				}
				return null;
			})}
		</div>
	`;
}

// The three pickers below are pure display: Composer owns filtering AND
// selection so arrow-key nav and mouse click always agree on the same list.
function CommandPalette({ items, selectedIndex, running, onHover, onSelect, visible }) {
	if (!visible || items.length === 0) return null;

	return html`
		<div class="cmd-palette open">
			${items.map((c, i) => {
				const disabled = c.blocking && running;
				const cls = `cmd-item${disabled ? " disabled" : ""}${i === selectedIndex ? " selected" : ""}`;
				return html`
					<div key=${c.name} class=${cls} onMouseEnter=${() => onHover(i)} onClick=${() => !disabled && onSelect(c.name)}>
						<span class="cmd-name">${c.name}</span>
						<span class="cmd-desc">${c.description}</span>
						${disabled && html`<span class="cmd-blocked-hint">idle only</span>`}
					</div>
				`;
			})}
		</div>
	`;
}

// Shared by every "/command <value>" suggestion list — persona, theme,
// model, reasoning level, web-tools on/off — once normalized to a plain
// {value, label} shape (see Composer's pickerItems). One less near-duplicate
// component per new argument-taking command.
function ValueSuggest({ items, selectedIndex, onHover, onSelect }) {
	if (items.length === 0) return null;

	return html`
		<div class="cmd-palette open">
			${items.map(
				(it, i) => html`
				<div key=${it.value} class="cmd-item${i === selectedIndex ? " selected" : ""}" onMouseEnter=${() => onHover(i)} onClick=${() => onSelect(it.value)}>
					<span class="cmd-name">${it.value}</span>
					<span class="cmd-desc">${it.label}</span>
				</div>
			`,
			)}
		</div>
	`;
}

function Composer({ running, ready, commands, personas, onSubmit, onAbort }) {
	const [value, setValue] = useState("");
	const [cmdVisible, setCmdVisible] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const textareaRef = useRef(null);
	const pickerRef = useRef(null);

	// Only /persona still lives in the composer — model, theme, reasoning,
	// web-tools, MCP/skills/plugins/provider/SSH, and the rest of the former
	// sub-arg pickers moved to the Settings modal (see SettingsModal) so
	// typing "/" only ever surfaces conversation-flow commands.
	const personaMatch = /^\/persona\s+(\S*)$/i.exec(value);

	const resize = useCallback(() => {
		const el = textareaRef.current;
		if (el) {
			el.style.height = "auto";
			el.style.height = `${Math.min(el.scrollHeight, 100)}px`;
		}
	}, []);

	const handleSubmit = useCallback(() => {
		const trimmed = value.trim();
		if (!trimmed) return;
		onSubmit(trimmed);
		setValue("");
		setCmdVisible(false);
		if (textareaRef.current) textareaRef.current.style.height = "auto";
	}, [value, onSubmit]);

	const handleCmdSelect = useCallback(
		(name) => {
			// Argument-less commands (help, current, usage, ...) should just run —
			// filling the box with "/current " and waiting for a second Enter is
			// exactly the "picker doesn't work" feeling this is meant to fix.
			const cmd = commands.find((c) => c.name === name);
			if (cmd && !cmd.takesArgs) {
				onSubmit(name);
				setValue("");
				setCmdVisible(false);
				if (textareaRef.current) textareaRef.current.style.height = "auto";
				return;
			}
			setValue(`${name} `);
			setCmdVisible(false);
			textareaRef.current?.focus();
			requestAnimationFrame(resize);
		},
		[commands, onSubmit, resize],
	);

	const handlePersonaSelect = useCallback(
		(name) => {
			onSubmit(`/persona ${name}`);
			setValue("");
			if (textareaRef.current) textareaRef.current.style.height = "auto";
		},
		[onSubmit],
	);

	const handleInput = useCallback(
		(e) => {
			const val = e.target.value;
			setValue(val);
			setCmdVisible(val.startsWith("/") && !val.includes(" "));
			setSelectedIndex(0);
			resize();
		},
		[resize],
	);

	// One active picker at a time — Composer owns the filtered list and the
	// selection index so arrow keys and mouse clicks act on the exact same
	// row order, whichever picker happens to be showing. Persona/model
	// normalize to {value, label} so ValueSuggest can render either the same way.
	let pickerItems = [];
	let pickerSelect = null;
	if (personaMatch) {
		pickerItems = personas
			.filter((p) => p.name.toLowerCase().startsWith(personaMatch[1].toLowerCase()))
			.map((p) => ({ value: p.name, label: p.label }));
		pickerSelect = handlePersonaSelect;
	} else if (cmdVisible) {
		pickerItems = (value ? commands.filter((c) => c.name.startsWith(value)) : commands).filter((c) => !c.hidden);
		pickerSelect = handleCmdSelect;
	}
	const clampedIndex = pickerItems.length > 0 ? Math.min(selectedIndex, pickerItems.length - 1) : 0;

	// Arrow-key nav must scroll the picker, not just select past the visible
	// edge — mouse/scroll-wheel already worked, but the highlighted row could
	// silently move off-screen when reached via the keyboard.
	// biome-ignore lint/correctness/useExhaustiveDependencies: clampedIndex isn't read in the body — it's the trigger to re-scroll to the now-selected row, found via DOM query instead of the value itself.
	useEffect(() => {
		pickerRef.current?.querySelector(".cmd-item.selected")?.scrollIntoView({ block: "nearest" });
	}, [clampedIndex]);

	const handleKeyDown = useCallback(
		(e) => {
			// Esc stops a running turn — checked before anything else so it wins
			// regardless of what's in the composer (an open command palette, a
			// half-typed /steer), matching the TUI's Escape-aborts behavior. The
			// hotkeys reference has always listed this; the web port just never
			// actually wired it up until now.
			if (e.key === "Escape" && running) {
				e.preventDefault();
				onAbort();
				return;
			}
			if (pickerItems.length > 0) {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					setSelectedIndex((clampedIndex + 1) % pickerItems.length);
					return;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					setSelectedIndex((clampedIndex - 1 + pickerItems.length) % pickerItems.length);
					return;
				}
				if (e.key === "Escape") {
					setCmdVisible(false);
					return;
				}
				if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
					const item = pickerItems[clampedIndex];
					const disabled = item && "blocking" in item && item.blocking && running;
					if (item && !disabled) {
						e.preventDefault();
						pickerSelect(item.value ?? item.name ?? item.id);
						return;
					}
				}
			}
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				handleSubmit();
			}
		},
		// biome-ignore lint/correctness/useExhaustiveDependencies: pickerItems/pickerSelect are plain values recomputed every render (not memoized) — already fine since this callback is rebuilt on every keystroke (`value` is a dep) regardless.
		[pickerItems, clampedIndex, pickerSelect, running, handleSubmit, onAbort],
	);

	return html`
		<div class="composer-wrap">
			<div ref=${pickerRef}>
				${
					personaMatch
						? html`<${ValueSuggest} items=${pickerItems} selectedIndex=${clampedIndex} onHover=${setSelectedIndex} onSelect=${pickerSelect} />`
						: html`<${CommandPalette} items=${pickerItems} selectedIndex=${clampedIndex} running=${running} visible=${cmdVisible} onHover=${setSelectedIndex} onSelect=${handleCmdSelect} />`
				}
			</div>
			<div class="composer">
				<textarea
					ref=${textareaRef}
					class="composer-input"
					placeholder=${!ready ? "Connecting…" : pickerItems.length > 0 ? "↑↓ to navigate, Enter to pick" : "Type a message or / for commands..."}
					rows="1"
					disabled=${!ready}
					value=${value}
					onInput=${handleInput}
					onKeyDown=${handleKeyDown}
				/>
				${
					running
						? html`<button class="composer-abort" onClick=${onAbort} aria-label="Abort"><${icons.stop} /></button>`
						: html`<button class="composer-send" onClick=${handleSubmit} disabled=${!ready || !value.trim()} aria-label="Send"><${icons.send} /></button>`
				}
			</div>
		</div>
	`;
}

function DiffPanel({ data, activeFile, onSelectFile, onClose, onResizeStart, open }) {
	const openClass = open ? " open" : "";
	if (!data)
		return html`
		<aside class="diff-panel${openClass}">
			<div class="diff-resize-handle" onPointerDown=${onResizeStart} />
			<div class="diff-empty">Loading...</div>
		</aside>
	`;

	// Directories first (grouped and sorted alphabetically by their full
	// path), then root-level files — same convention as a file explorer /
	// GitLab's diff view, instead of one flat alphabetical list that
	// interleaves nested and root files arbitrarily.
	const files = [...(data.files || [])].sort((a, b) => {
		const aRoot = !a.path.includes("/");
		const bRoot = !b.path.includes("/");
		if (aRoot !== bRoot) return aRoot ? 1 : -1;
		return a.path.localeCompare(b.path);
	});
	const file = activeFile ? files.find((f) => f.path === activeFile) : files[0];

	// Pre-compute hunk lines outside htm template
	let diffContent = null;
	if (file && file.hunks.length > 0) {
		diffContent = file.hunks.map((hunk, hi) => {
			let addN = hunk.newStart;
			let delN = hunk.oldStart;
			const lines = hunk.lines.map((line, li) => {
				const typeClass = line.type === "+" ? "diff-line-add" : line.type === "-" ? "diff-line-del" : "";
				let num = "";
				if (line.type === "+") {
					num = addN;
					addN++;
				} else if (line.type === "-") {
					num = delN;
					delN++;
				}
				return { key: li, typeClass, num, content: line.content };
			});
			return { hi, hunk, lines };
		});
	}

	return html`
		<aside class="diff-panel${openClass}">
			<div class="diff-resize-handle" onPointerDown=${onResizeStart} />
			<div class="diff-header">
				<span class="diff-title">Changes</span>
				<button class="diff-close" onClick=${onClose} aria-label="Close"><${icons.xMark} /></button>
			</div>
			<div class="diff-file-list">
				${files.map(
					(f) => html`
					<div key=${f.path} class="diff-file-item${f.path === (activeFile || file?.path) ? " active" : ""}" onClick=${() => onSelectFile(f.path)} title=${f.path}>
						<span class="diff-file-path">
							<span class="diff-file-dir">${f.path.slice(0, f.path.lastIndexOf("/") + 1)}</span><span class="diff-file-base">${f.path.slice(f.path.lastIndexOf("/") + 1)}</span>
						</span>
						<span class="diff-file-stats">
							<span class="add">+${f.additions}</span>
							<span class="del">-${f.deletions}</span>
						</span>
					</div>
				`,
				)}
			</div>
			<div class="diff-view">
				${
					diffContent
						? diffContent.map(
								(h) => html`
						<div key=${h.hi}>
							<div class="diff-hunk-header">@@ -${h.hunk.oldStart},${h.hunk.oldLines} +${h.hunk.newStart},${h.hunk.newLines} @@</div>
							${h.lines.map(
								(l) => html`
								<div key=${l.key} class="diff-line ${l.typeClass}">
									<span class="diff-line-num">${l.num}</span>
									<span class="diff-line-content">${l.content}</span>
								</div>
							`,
							)}
						</div>
					`,
							)
						: data.noRepo
							? html`<div class="diff-empty diff-empty-hint">This directory isn't a git repository yet.<br/>Ask the agent to run <code>git init</code> to enable the diff view.</div>`
							: data.error
								? html`<div class="diff-empty diff-empty-error">${data.error}</div>`
								: html`<div class="diff-empty">No changes</div>`
				}
			</div>
		</aside>
	`;
}

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

// Shared by every modal (dir picker, status, settings, hotkeys): moves focus
// into the dialog on open, keeps Tab from leaking to the page behind the
// backdrop, and hands focus back to whatever triggered it on close — none of
// that happens for free just from the backdrop/click-outside handling.
function useModalFocusTrap(active) {
	const ref = useRef(null);
	useEffect(() => {
		if (!active) return;
		const container = ref.current;
		const previouslyFocused = document.activeElement;
		(container?.querySelector(FOCUSABLE_SELECTOR) || container)?.focus();

		const onKeyDown = (e) => {
			if (e.key !== "Tab" || !container) return;
			const focusables = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR));
			if (focusables.length === 0) return;
			const first = focusables[0];
			const last = focusables[focusables.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			previouslyFocused?.focus?.();
		};
	}, [active]);
	return ref;
}

// Read-only folder browser (like a native "Open Folder" dialog) for picking
// a new session's working directory — /api/browse lists subdirectories only,
// server-side, and this just walks that one level at a time.
function DirectoryBrowser({ initialPath, onPick, onClose }) {
	const [path, setPath] = useState(initialPath || "");
	const [parent, setParent] = useState(null);
	const [entries, setEntries] = useState([]);
	const [error, setError] = useState(null);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async (p) => {
		setLoading(true);
		try {
			const data = await api("GET", `/api/browse?path=${encodeURIComponent(p ?? "")}`);
			if (data) {
				setPath(data.path);
				setParent(data.parent);
				setEntries(data.entries || []);
				setError(data.error ?? null);
			}
		} catch (err) {
			setError(err.message);
		}
		setLoading(false);
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: initialPath seeds the first load only — later navigation uses load(parent)/load(entry.path), so re-running this on prop changes would fight in-modal navigation. load itself never changes (empty deps).
	useEffect(() => {
		load(initialPath);
	}, []);
	const modalRef = useModalFocusTrap(true);

	return html`
		<div class="modal-backdrop" onClick=${onClose}>
			<div class="modal" role="dialog" aria-modal="true" aria-label="Choose working directory" tabIndex="-1" ref=${modalRef} onClick=${(e) => e.stopPropagation()}>
				<div class="modal-header">
					<span>Choose working directory</span>
					<button class="modal-close" onClick=${onClose} aria-label="Close"><${icons.xMark} /></button>
				</div>
				<div class="dir-path" title=${path}>${path}</div>
				<div class="dir-list">
					${
						parent !== null &&
						html`
						<div class="dir-item dir-item-up" onClick=${() => load(parent)}>.. (parent directory)</div>
					`
					}
					${entries.map(
						(e) => html`
						<div key=${e.path} class="dir-item" onClick=${() => load(e.path)}>${e.name}</div>
					`,
					)}
					${!loading && entries.length === 0 && !error && html`<div class="dir-empty">No subdirectories</div>`}
					${error && html`<div class="dir-error">${error}</div>`}
				</div>
				<div class="modal-footer">
					<button class="modal-btn" onClick=${onClose}>Cancel</button>
					<button class="modal-btn modal-btn-primary" onClick=${() => onPick(path)}>Use this folder</button>
				</div>
			</div>
		</div>
	`;
}

const SETTINGS_TABS = [
	{ id: "mcp", label: "MCP" },
	{ id: "model", label: "Model" },
	{ id: "plugins", label: "Plugins" },
	{ id: "provider", label: "Provider" },
	{ id: "skills", label: "Skills" },
	{ id: "ssh", label: "SSH" },
	{ id: "theme", label: "Theme" },
	{ id: "tools", label: "Tools" },
];

// A centered modal, same treatment as the Hotkeys reference — an anchored
// corner dropdown doesn't have anywhere safe to sit on a narrow screen (the
// status button lives among 3 others in the header, nowhere near the actual
// right edge, so "align to the button" pushed it half off the left side of
// the viewport on mobile). Status is a glance-and-close read either way, so
// a modal costs nothing here and works identically at any viewport width.
// Reloads on every open since usage/message-count/git-dirty drift constantly.
function StatusPopover({ activeId, running }) {
	const [open, setOpen] = useState(false);
	const [data, setData] = useState(null);
	const [error, setError] = useState(null);

	const load = useCallback(async () => {
		setError(null);
		try {
			const [current, repo] = await Promise.all([
				api("POST", `/api/sessions/${activeId}/command`, { command: "/current" }),
				api("POST", `/api/sessions/${activeId}/command`, { command: "/repo" }),
			]);
			setData({ current: current?.result, repo: repo?.result });
		} catch (err) {
			setError(err.message);
		}
	}, [activeId]);

	const openModal = useCallback(() => {
		setOpen(true);
		load();
	}, [load]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);

	// Left open across a turn, the numbers it showed on open go stale the
	// moment a reply lands — reload the instant `running` flips back to
	// false so it never needs a manual close/reopen (or a page refresh) to
	// catch up.
	const wasRunning = useRef(running);
	useEffect(() => {
		if (open && wasRunning.current && !running) load();
		wasRunning.current = running;
	}, [running, open, load]);
	const modalRef = useModalFocusTrap(open);

	return html`
		<button class="menu-toggle" onClick=${openModal} aria-label="Status" title="Status">
			<${icons.info} />
		</button>
		${
			open &&
			html`
			<div class="modal-backdrop" onClick=${() => setOpen(false)}>
				<div class="modal modal-status" role="dialog" aria-modal="true" aria-label="Status" tabIndex="-1" ref=${modalRef} onClick=${(e) => e.stopPropagation()}>
					<div class="modal-header">
						<span>Status</span>
						<button class="modal-close" onClick=${() => setOpen(false)} aria-label="Close"><${icons.xMark} /></button>
					</div>
					<div class="modal-status-body">
						${error && html`<div class="settings-error">${error}</div>`}
						${!data && !error ? html`<div class="settings-loading">Loading…</div>` : html`<${SettingsStatus} data=${data} />`}
					</div>
				</div>
			</div>
		`
		}
	`;
}

// Everything that used to be a slash command typed into the composer but
// isn't part of the actual back-and-forth with the agent (MCP/skills/
// plugins/provider/SSH management, theme, model/reasoning details, usage) —
// consolidated here so the chat transcript stays just the conversation.
// Every action still runs through the exact same POST /command endpoint the
// composer used, just without ever appending a chat notice for it.
function SettingsModal({ activeId, themes, currentThemeId, onApplyTheme, onThemeChange, onClose, confirm }) {
	const [tab, setTab] = useState("model");
	const [data, setData] = useState({});
	const [errors, setErrors] = useState({});
	const [busy, setBusy] = useState(false);

	const run = useCallback(
		async (command) => {
			try {
				return await api("POST", `/api/sessions/${activeId}/command`, { command });
			} catch (err) {
				return { ok: false, error: err.message };
			}
		},
		[activeId],
	);

	const load = useCallback(
		async (t) => {
			setErrors((e) => ({ ...e, [t]: null }));
			if (t === "model") {
				const [models, reasoning, current, providers] = await Promise.all([
					api("GET", "/api/models/cached").catch(() => null),
					api("GET", `/api/sessions/${activeId}/reasoning-options`).catch(() => null),
					run("/current"),
					run("/provider list"),
				]);
				setData((d) => ({
					...d,
					model: {
						models: models?.models ?? [],
						reasoningOptions: reasoning?.options ?? [],
						current: current?.result,
						providers: providers?.result ?? [],
					},
				}));
			} else if (t === "tools") {
				const [web, permissions] = await Promise.all([run("/web"), run("/permissions")]);
				setData((d) => ({ ...d, tools: { web: web?.result, permissions: permissions?.result } }));
			} else if (t === "mcp") {
				const res = await run("/mcp list");
				if (!res.ok) {
					setErrors((e) => ({ ...e, mcp: res.error }));
					return;
				}
				setData((d) => ({ ...d, mcp: res.result }));
			} else if (t === "skills") {
				const res = await run("/skills list");
				if (!res.ok) {
					setErrors((e) => ({ ...e, skills: res.error }));
					return;
				}
				setData((d) => ({ ...d, skills: res.result }));
			} else if (t === "plugins") {
				const [plugins, marketplaces] = await Promise.all([run("/plugin list"), run("/plugin marketplace list")]);
				setData((d) => ({
					...d,
					plugins: { plugins: plugins?.result ?? [], marketplaces: marketplaces?.result ?? [] },
				}));
			} else if (t === "provider") {
				const res = await run("/provider list");
				if (!res.ok) {
					setErrors((e) => ({ ...e, provider: res.error }));
					return;
				}
				setData((d) => ({ ...d, provider: res.result }));
			} else if (t === "ssh") {
				const res = await run("/ssh list");
				if (!res.ok) {
					setErrors((e) => ({ ...e, ssh: res.error }));
					return;
				}
				setData((d) => ({ ...d, ssh: res.result }));
			}
		},
		[run, activeId],
	);

	// Preload every tab in parallel as soon as the modal mounts (or the active
	// session changes) — clicking a tab then just shows what's already there
	// instead of a fresh fetch-and-flash "Loading…" every single time.
	// biome-ignore lint/correctness/useExhaustiveDependencies: activeId isn't read in the body directly, but load() closes over it (see `run`'s deps above) — re-running this on session switch is the intended behavior.
	useEffect(() => {
		for (const t of SETTINGS_TABS) load(t.id);
	}, [activeId, load]);
	const modalRef = useModalFocusTrap(true);
	useEffect(() => {
		const onKey = (e) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	// Runs a mutating command, shows any error inline, and reloads the
	// current tab's data on success so the list reflects the new state
	// immediately instead of waiting for the next manual refresh.
	const act = useCallback(
		async (command) => {
			setBusy(true);
			setErrors((e) => ({ ...e, [tab]: null }));
			const res = await run(command);
			if (!res.ok) setErrors((e) => ({ ...e, [tab]: res.error ?? "Failed" }));
			await load(tab);
			setBusy(false);
			return res;
		},
		[run, load, tab],
	);

	// theme's data comes from the `themes` prop (fetched once at app boot,
	// always present already) rather than the per-tab preload above.
	const hasData = tab === "theme" || data[tab] !== undefined;

	return html`
		<div class="modal-backdrop" onClick=${onClose}>
			<div class="modal settings-modal" role="dialog" aria-modal="true" aria-label="Settings" tabIndex="-1" ref=${modalRef} onClick=${(e) => e.stopPropagation()}>
				<div class="modal-header">
					<span>Settings</span>
					<div style=${{ display: "flex", gap: "6px", alignItems: "center" }}>
						<button class="modal-btn" disabled=${busy} onClick=${() => act("/reload")}>Reload resources</button>
						<button class="modal-close" onClick=${onClose} aria-label="Close"><${icons.xMark} /></button>
					</div>
				</div>
				<div class="settings-body">
					<div class="settings-tabs">
						${SETTINGS_TABS.map(
							(t) => html`
							<button key=${t.id} class="settings-tab${tab === t.id ? " active" : ""}" onClick=${() => setTab(t.id)}>${t.label}</button>
						`,
						)}
					</div>
					<div class="settings-pane">
						${errors[tab] && html`<div class="settings-error">${errors[tab]}</div>`}
						${
							!hasData
								? html`<div class="settings-loading">Loading…</div>`
								: tab === "model"
									? html`<${SettingsModel} data=${data.model} busy=${busy} act=${act} />`
									: tab === "theme"
										? html`<${SettingsTheme} themes=${themes} currentThemeId=${currentThemeId} onPick=${async (
												id,
											) => {
												const res = await act(`/theme ${id}`);
												if (res.ok && res.result?.colors) onApplyTheme(res.result.colors);
												if (res.ok && res.result?.theme) onThemeChange(res.result.theme);
											}} />`
										: tab === "tools"
											? html`<${SettingsTools} data=${data.tools} busy=${busy} act=${act} />`
											: tab === "mcp"
												? html`<${SettingsMcp} data=${data.mcp} busy=${busy} act=${act} confirm=${confirm} />`
												: tab === "skills"
													? html`<${SettingsSkills} data=${data.skills} busy=${busy} act=${act} confirm=${confirm} />`
													: tab === "plugins"
														? html`<${SettingsPlugins} data=${data.plugins} busy=${busy} act=${act} confirm=${confirm} />`
														: tab === "provider"
															? html`<${SettingsProvider} data=${data.provider} busy=${busy} act=${act} confirm=${confirm} />`
															: tab === "ssh"
																? html`<${SettingsSsh} data=${data.ssh} busy=${busy} act=${act} confirm=${confirm} />`
																: null
						}
					</div>
				</div>
			</div>
		</div>
	`;
}

function SettingsStatus({ data }) {
	if (!data) return null;
	const c = data.current || {};
	const r = data.repo || {};
	const u = c.usage || {};
	return html`
		<div class="settings-rows">
			<div class="settings-row"><span>Persona</span><span>${c.persona ?? "—"}</span></div>
			<div class="settings-row"><span>Model</span><span>${c.model ?? "—"}</span></div>
			<div class="settings-row"><span>Mode</span><span>${c.mode ?? "build"}</span></div>
			<div class="settings-row"><span>Status</span><span>${c.status ?? "—"}</span></div>
			<div class="settings-row"><span>Messages</span><span>${c.messageCount ?? 0}</span></div>
			<div class="settings-row"><span>Tokens</span><span>${u.totalTokens ?? 0} (${u.promptTokens ?? 0} in / ${u.completionTokens ?? 0} out)</span></div>
			${u.cost ? html`<div class="settings-row"><span>Cost</span><span>$${u.cost.toFixed(4)}</span></div>` : null}
			${c.lastTurn?.tokensPerSecond ? html`<div class="settings-row"><span>Last turn</span><span>${c.lastTurn.tokensPerSecond} tok/s (${(c.lastTurn.generationMs / 1000).toFixed(1)}s)</span></div>` : null}
			<div class="settings-row"><span>Directory</span><span title=${r.cwd}>${shortPath(r.cwd)}</span></div>
			${r.isGit && html`<div class="settings-row"><span>Git branch</span><span>${r.branch}${r.dirty ? " (dirty)" : ""}</span></div>`}
			${r.isGit === false && html`<div class="settings-row"><span>Git</span><span>not a repository</span></div>`}
		</div>
	`;
}

/**
 * Cascading provider → model picker.  When the user picks a provider its
 * /v1/models list is fetched and shown in the model dropdown.  The "Set"
 * button fires two commands: one to set the provider, one to set the model.
 * "Reset" clears both overrides so the slot falls back to the active provider
 * and main model.
 */
/**
 * Cascading provider → model picker.
 * @param providerCommand  e.g. "/subagent-model-provider" or "/provider"
 * @param modelCommand      e.g. "/subagent-model" or "/model"
 */
function SlotModelPicker({
	busy,
	act,
	providers,
	activeProviderName,
	currentProvider,
	currentModel,
	fallbackModel,
	providerCommand,
	modelCommand,
	isMainSlot,
	initialModels,
}) {
	const initialProvider = currentProvider || "";
	const effectiveModel = currentModel || fallbackModel || "";
	const [providerValue, setProviderValue] = useState(initialProvider);
	const [modelValue, setModelValue] = useState(effectiveModel);
	const [models, setModels] = useState(initialModels || []);
	const [loading, setLoading] = useState(false);

	// Label for the empty option in the provider dropdown.
	const defaultLabel = activeProviderName || (providers.length > 1 ? "Select…" : "Active");

	// Fetch models on mount: use cached endpoint for instant load, then
	// optionally re-fetch from a specific provider if one is pinned.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			if (!initialModels?.length) {
				// No models from parent — load cached ones instantly.
				try {
					const res = await api("GET", "/api/models/cached");
					if (!cancelled && res?.models?.length) {
						setModels(res.models);
					}
				} catch {
					/* ignore */
				}
			}
			// If a specific provider is pinned (not the active one), fetch from it.
			if (initialProvider) {
				setLoading(true);
				try {
					const res = await api("GET", `/api/models?provider=${encodeURIComponent(initialProvider)}`);
					if (!cancelled) setModels(res?.models ?? []);
				} catch {
					if (!cancelled) setModels([]);
				}
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [initialModels?.length, initialProvider]);

	// Fetch models when provider changes.
	const onProviderChange = useCallback(async (name) => {
		setProviderValue(name);
		setModelValue("");
		setLoading(true);
		try {
			const qs = name ? `?provider=${encodeURIComponent(name)}` : "";
			const res = await api("GET", `/api/models${qs}`);
			setModels(res?.models ?? []);
		} catch {
			setModels([]);
		}
		setLoading(false);
	}, []);

	const doSet = useCallback(async () => {
		if (providerValue) await act(`${providerCommand} ${providerValue}`);
		if (modelValue) await act(`${modelCommand} ${modelValue}`);
	}, [providerValue, modelValue, act, providerCommand, modelCommand]);

	const doReset = useCallback(async () => {
		if (providerCommand !== "/provider") await act(`${providerCommand} off`);
		await act(`${modelCommand} off`);
		setProviderValue("");
		setModelValue("");
		setModels([]);
	}, [act, providerCommand, modelCommand]);

	const hasOverride = currentProvider || currentModel;

	return html`
		<div class="settings-form-row">
			<select disabled=${busy} value=${providerValue} onChange=${(e) => onProviderChange(e.target.value)}>
				<option value="">${defaultLabel}</option>
				${providers.map((p) => html`<option key=${p.name} value=${p.name}>${p.name} — ${p.url}</option>`)}
			</select>
			<select disabled=${busy || loading} onChange=${(e) => setModelValue(e.target.value)} value=${modelValue}>
				<option value="">${loading ? "Loading…" : currentModel ? "Pick a model…" : fallbackModel ? `${fallbackModel} (default)` : "Pick a model…"}</option>
				${[...models].sort((a, b) => a.id.localeCompare(b.id)).map((m) => html`<option key=${m.id} value=${m.id}>${m.id}${m.reasoning ? " (reasoning)" : ""}</option>`)}
			</select>
			<button class="modal-btn icon-btn" title="Apply" disabled=${busy || !modelValue} onClick=${doSet}><${icons.check} /></button>
			${!isMainSlot ? html`<button class="modal-btn icon-btn" title="Clear model override" disabled=${busy} onClick=${() => act(`${modelCommand} off`)}><${icons.xCircle} /></button>` : null}
			${!isMainSlot && hasOverride ? html`<button class="modal-btn icon-btn" title="Reset all overrides" disabled=${busy} onClick=${doReset}><${icons.arrowUturnLeft} /></button>` : null}
		</div>
	`;
}

function SettingsModel({ data, busy, act }) {
	const [reasoningValue, setReasoningValue] = useState("");
	if (!data) return null;
	const c = data.current || {};
	const providers = data.providers || [];
	const activeProviderName = providers.find((p) => p.active)?.name ?? "";
	return html`
		<div class="settings-rows">
			<div class="settings-section-title">Model — current: ${c.model ?? "—"}</div>
			<${SlotModelPicker} busy=${busy} act=${act} providers=${providers} activeProviderName=${activeProviderName} currentModel=${c.model} providerCommand="/provider" modelCommand="/model" isMainSlot=${true} initialModels=${data.models} />
			<div class="settings-section-title">Reasoning — current: ${c.reasoningLevel ?? "off"}</div>
			${
				data.reasoningOptions.length === 0
					? html`<div class="settings-hint">This model exposes no reasoning controls.</div>`
					: html`
					<div class="settings-form-row">
						<select onChange=${(e) => setReasoningValue(e.target.value)}>
							<option value="">Pick a level…</option>
							${data.reasoningOptions.map((o) => html`<option key=${o.value} value=${o.value}>${o.label}</option>`)}
						</select>
						<button class="modal-btn icon-btn" title="Apply reasoning" disabled=${busy || !reasoningValue} onClick=${() => act(`/reasoning ${reasoningValue}`)}><${icons.check} /></button>
					</div>
				`
			}
			<div class="settings-section-title">Subagent model — current: ${c.subagentModel ?? c.model ?? "—"}${c.subagentModelProvider ? ` @ ${c.subagentModelProvider}` : ""}</div>
			<${SlotModelPicker} busy=${busy} act=${act} providers=${providers} activeProviderName=${activeProviderName} currentProvider=${c.subagentModelProvider} currentModel=${c.subagentModel} fallbackModel=${c.model} providerCommand="/subagent-model-provider" modelCommand="/subagent-model" initialModels=${data.models} />
			<div class="settings-section-title">Plan-mode model — current: ${c.planModel ?? c.model ?? "—"}${c.planModelProvider ? ` @ ${c.planModelProvider}` : ""}</div>
			<${SlotModelPicker} busy=${busy} act=${act} providers=${providers} activeProviderName=${activeProviderName} currentProvider=${c.planModelProvider} currentModel=${c.planModel} fallbackModel=${c.model} providerCommand="/plan-model-provider" modelCommand="/plan-model" initialModels=${data.models} />
		</div>
	`;
}

function SettingsTheme({ themes, currentThemeId, onPick }) {
	return html`
		<div class="settings-theme-grid">
			${[...(themes || [])]
				.sort((a, b) => a.label.localeCompare(b.label))
				.map(
					(t) => html`
				<button key=${t.id} class="settings-theme-swatch${t.id === currentThemeId ? " active" : ""}" style=${{ "--swatch-accent": t.colors?.accent }} onClick=${() => onPick(t.id)} title=${t.description}>
					<span class="settings-theme-dot" />
					${t.label}
				</button>
			`,
				)}
		</div>
	`;
}

function InfoPopover({ text, readUrl }) {
	const [open, setOpen] = useState(false);
	const [fullContent, setFullContent] = useState(null);
	const [loading, setLoading] = useState(false);
	useEffect(() => {
		if (!open) return;
		const onKey = (e) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(false);
				setFullContent(null);
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open]);
	const loadFull = async () => {
		setOpen(true);
		setLoading(true);
		try {
			const res = await api("GET", readUrl);
			setFullContent(res?.content || res?.error || "No content");
		} catch {
			setFullContent("Failed to load");
		}
		setLoading(false);
	};
	const close = () => {
		setOpen(false);
		setFullContent(null);
	};
	if (!text && !readUrl) return null;
	return [
		html`<span class="info-popover-wrap" style=${{ display: "inline-flex", gap: "2px" }}>
			${
				text
					? html`<button class="modal-btn icon-btn" title="Description" onClick=${(e) => {
							e.stopPropagation();
							setFullContent(null);
							setOpen(true);
						}}><${icons.info} /></button>`
					: null
			}
			${
				readUrl
					? html`<button class="modal-btn icon-btn" title="Read full content" onClick=${(e) => {
							e.stopPropagation();
							loadFull();
						}}><${icons.bookOpen} /></button>`
					: null
			}
		</span>`,
		open && html`<div class="info-popover-backdrop" onClick=${close} />`,
		open &&
			html`<div class="info-popover" onClick=${(e) => e.stopPropagation()}>
			<div class="info-popover-header"><button class="modal-btn icon-btn" onClick=${close}><${icons.xMark} /></button></div>
			<div class="info-popover-text">${loading ? "Loading…" : fullContent || text}</div>
		</div>`,
	];
}

function SettingsTools({ data, busy, act }) {
	if (!data) return null;
	const web = data.web || {};
	const perm = data.permissions || {};
	const webOn = web.webTools;
	return html`
		<div class="settings-rows">
			<div class="settings-section-title">Web tools</div>
			<div class="settings-form-row">
				<button class="modal-btn${webOn ? " modal-btn-primary" : ""}" title="Enable web_search and web_fetch" disabled=${busy} onClick=${() => act("/web on")}>Enabled</button>
				<button class="modal-btn${!webOn ? " modal-btn-primary" : ""}" title="Disable web_search and web_fetch" disabled=${busy} onClick=${() => act("/web off")}>Disabled</button>
			</div>
			<div class="settings-section-title">Bash confirmation mode</div>
			<div class="settings-form-row">
				<button class="modal-btn${perm.permissionMode === "default" ? " modal-btn-primary" : ""}" title="Confirm dangerous commands" disabled=${busy} onClick=${() => act("/permissions default")}>Default</button>
				<button class="modal-btn${perm.permissionMode === "bypass" ? " modal-btn-primary" : ""}" title="Skip confirmation prompts" disabled=${busy} onClick=${() => act("/permissions bypass")}>Bypass</button>
			</div>
		</div>
	`;
}

function SettingsMcp({ data, busy, act, confirm }) {
	const servers = data || [];
	const groups = [
		{ key: "global", label: "Global", items: servers.filter((s) => s.source === "global") },
		{ key: "project", label: "Project", items: servers.filter((s) => s.source === "project") },
	];
	const renderServer = (s) => html`
		<div key=${s.name} class="settings-item-row">
			<div class="settings-item-info">
				<span class="settings-item-status ${s.connected ? "ok" : "off"}" />
				<span class="settings-item-name">${s.name}</span>
				<span class="settings-item-meta">${s.disabled ? "disabled" : s.connected ? "connected" : "not connected"}</span>
			</div>
			<div class="settings-item-actions">
				<button class="modal-btn icon-btn" title=${s.disabled ? "Enable" : "Disable"} disabled=${busy} onClick=${() => act(`/mcp ${s.disabled ? "enable" : "disable"} ${s.name}`)}>${s.disabled ? html`<${icons.play} />` : html`<${icons.pause} />`}</button>
				<button class="modal-btn icon-btn modal-btn-danger" title="Uninstall" disabled=${busy} onClick=${async () => {
					if (await confirm(`Uninstall MCP server "${s.name}"?`)) act(`/mcp uninstall ${s.name}`);
				}}><${icons.trash} /></button>
			</div>
		</div>
	`;
	return html`
		<div class="settings-rows">
			${groups
				.filter((g) => g.items.length > 0)
				.map(
					(g) => html`
				<div key=${g.key} class="settings-group">
					<div class="settings-section-title">${g.label}</div>
					${[...g.items].sort((a, b) => a.name.localeCompare(b.name)).map(renderServer)}
				</div>
			`,
				)}
			${servers.length === 0 && html`<div class="settings-hint">No MCP servers configured.</div>`}
		</div>
	`;
}

function SettingsSkills({ data, busy, act, confirm }) {
	const skills = data || [];
	const groups = [
		{ key: "builtin", label: "Built-in", items: skills.filter((s) => s.source === "builtin") },
		{ key: "global", label: "Global", items: skills.filter((s) => s.source === "global") },
		{
			key: "project",
			label: "Project",
			items: skills.filter((s) => s.source === "project" || s.source === "agents" || s.source === "path"),
		},
		{ key: "plugin", label: "Plugins", items: skills.filter((s) => s.source === "plugin") },
	];
	const renderSkill = (s) => html`
		<div key=${s.name} class="settings-item-row">
			<div class="settings-item-info">
				<span class="settings-item-status ${s.enabled ? "ok" : "off"}" />
				<span class="settings-item-name">${s.name}</span>
				<span class="settings-item-meta">${s.source === "plugin" && s.pluginId ? s.pluginId : s.source}</span>
				<${InfoPopover} text=${s.description} readUrl=${`/api/skill-content?name=${encodeURIComponent(s.name)}`} />
			</div>
			<div class="settings-item-actions">
				<button class="modal-btn icon-btn" title=${s.enabled ? "Disable" : "Enable"} disabled=${busy} onClick=${() => act(`/skills ${s.enabled ? "disable" : "enable"} ${s.name}`)}>${s.enabled ? html`<${icons.pause} />` : html`<${icons.play} />`}</button>
				${
					s.uninstallable &&
					html`<button class="modal-btn icon-btn modal-btn-danger" title="Uninstall" disabled=${busy} onClick=${async () => {
						if (await confirm(`Uninstall skill "${s.name}"?`)) act(`/skills uninstall ${s.name}`);
					}}><${icons.trash} /></button>`
				}
			</div>
		</div>
	`;
	return html`
		<div class="settings-rows">
			${groups
				.filter((g) => g.items.length > 0)
				.map(
					(g) => html`
				<div key=${g.key} class="settings-group">
					<div class="settings-section-title">${g.label}</div>
					${[...g.items].sort((a, b) => a.name.localeCompare(b.name)).map(renderSkill)}
				</div>
			`,
				)}
			${skills.length === 0 && html`<div class="settings-hint">No skills found.</div>`}
		</div>
	`;
}

function SettingsPlugins({ data, busy, act, confirm }) {
	const [installRef, setInstallRef] = useState("");
	const [mpSource, setMpSource] = useState("");
	if (!data) return null;
	return html`
		<div class="settings-rows">
			<div class="settings-section-title">Installed plugins</div>
			${[...data.plugins]
				.sort((a, b) => a.id.localeCompare(b.id))
				.map(
					(p) => html`
				<div key=${p.id} class="settings-item-row">
					<div class="settings-item-info">
						<span class="settings-item-status ${p.enabled ? "ok" : "off"}" />
						<span class="settings-item-name">${p.plugin || p.id}</span>
						<span class="settings-item-meta">${p.marketplace || ""}</span>
						<${InfoPopover} text=${p.description} />
					</div>
					<div class="settings-item-actions">
						<button class="modal-btn icon-btn" title=${p.enabled ? "Disable" : "Enable"} disabled=${busy} onClick=${() => act(`/plugin ${p.enabled ? "disable" : "enable"} ${p.id}`)}>${p.enabled ? html`<${icons.pause} />` : html`<${icons.play} />`}</button>
						<button class="modal-btn icon-btn modal-btn-danger" title="Uninstall" disabled=${busy} onClick=${async () => {
							if (await confirm(`Uninstall plugin "${p.id}"?`)) act(`/plugin uninstall ${p.id}`);
						}}><${icons.trash} /></button>
					</div>
				</div>
			`,
				)}
			${data.plugins.length === 0 && html`<div class="settings-hint">No plugins installed.</div>`}
			<div class="settings-form-row">
				<input type="text" placeholder="name@marketplace" value=${installRef} onInput=${(e) => setInstallRef(e.target.value)} />
				<button class="modal-btn icon-btn" title="Install plugin" disabled=${busy || !installRef} onClick=${() => {
					act(`/plugin install ${installRef}`);
					setInstallRef("");
				}}><${icons.arrowDownTray} /></button>
			</div>
			<div class="settings-section-title">Marketplaces</div>
			${[...data.marketplaces]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(
					(mp) => html`
				<div key=${mp.name} class="settings-item-row">
					<div class="settings-item-info">
						<span class="settings-item-name">${mp.name}</span>
						<span class="settings-item-meta" title=${mp.source}>${shortPath(mp.source)}</span>
					</div>
					<div class="settings-item-actions">
						<button class="modal-btn icon-btn" title="Update" disabled=${busy} onClick=${() => act(`/plugin marketplace update ${mp.name}`)}><${icons.arrowPath} /></button>
						<button class="modal-btn icon-btn modal-btn-danger" title="Remove" disabled=${busy} onClick=${async () => {
							if (await confirm(`Remove marketplace "${mp.name}"?`))
								act(`/plugin marketplace remove ${mp.name}`);
						}}><${icons.trash} /></button>
					</div>
				</div>
			`,
				)}
			${data.marketplaces.length === 0 && html`<div class="settings-hint">No marketplaces added.</div>`}
			<div class="settings-form-row">
				<input type="text" placeholder="owner/repo, URL, or path" value=${mpSource} onInput=${(e) => setMpSource(e.target.value)} />
				<button class="modal-btn icon-btn" title="Add marketplace" disabled=${busy || !mpSource} onClick=${() => {
					act(`/plugin marketplace add ${mpSource}`);
					setMpSource("");
				}}><${icons.plus} /></button>
			</div>
		</div>
	`;
}

function SettingsProvider({ data, busy, act, confirm }) {
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [editing, setEditing] = useState(null);
	const startEdit = (p) => {
		setEditing(p.name);
		setName(p.name);
		setUrl(p.url);
		setApiKey(p.apiKey);
	};
	const cancelEdit = () => {
		setEditing(null);
		setName("");
		setUrl("");
		setApiKey("");
	};
	return html`
		<div class="settings-rows">
			${[...(data || [])]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(
					(p) => html`
				<div key=${p.name} class="settings-item-row">
					<div class="settings-item-info">
						<span class="settings-item-status ${p.active ? "ok" : "off"}" />
						<span class="settings-item-name">${p.name}</span>
						<span class="settings-item-meta" title=${p.url}>${shortPath(p.url)}</span>
					</div>
					<div class="settings-item-actions">
						<button class="modal-btn icon-btn" title="Edit" disabled=${busy} onClick=${() => startEdit(p)}><${icons.pencil} /></button>
						${!p.active ? html`<button class="modal-btn icon-btn" title="Switch" disabled=${busy} onClick=${() => act(`/provider ${p.name}`)}><${icons.arrowRight} /></button>` : null}
						<button class="modal-btn icon-btn modal-btn-danger" title="Delete" disabled=${busy} onClick=${async () => {
							if (await confirm(`Delete provider "${p.name}"?`)) act(`/provider delete ${p.name}`);
						}}><${icons.trash} /></button>
					</div>
				</div>
			`,
				)}
			${!data || data.length === 0 ? html`<div class="settings-hint">No saved providers.</div>` : null}
			<div class="settings-section-title">${editing ? `Edit provider: ${editing}` : "Add provider"}</div>
			<div class="settings-form-row">
				<input type="text" placeholder="name" value=${name} disabled=${!!editing} onInput=${(e) => setName(e.target.value)} />
				<input type="text" placeholder="base URL" value=${url} onInput=${(e) => setUrl(e.target.value)} />
				<input type="password" placeholder="API key" value=${apiKey} onInput=${(e) => setApiKey(e.target.value)} />
				<button class="modal-btn icon-btn" title=${editing ? "Save changes" : "Add provider"} disabled=${busy || !name || !url || !apiKey} onClick=${async () => {
					if (editing) {
						await act(`/provider delete ${editing}`);
						await act(`/provider add ${name} ${url} ${apiKey}`);
						if (data.find((p) => p.active && p.name === editing)) await act(`/provider ${name}`);
					} else {
						await act(`/provider add ${name} ${url} ${apiKey}`);
					}
					cancelEdit();
				}}><${icons.check} /></button>
				${editing ? html`<button class="modal-btn icon-btn" title="Cancel" disabled=${busy} onClick=${cancelEdit}><${icons.xCircle} /></button>` : null}
			</div>
		</div>
	`;
}

function SettingsSsh({ data, busy, act, confirm }) {
	const [name, setName] = useState("");
	const [host, setHost] = useState("");
	const [username, setUsername] = useState("");
	const [port, setPort] = useState("");
	const [keyContent, setKeyContent] = useState("");
	return html`
		<div class="settings-rows">
			${[...(data || [])]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(
					(h) => html`
				<div key=${h.name} class="settings-item-row">
					<div class="settings-item-info">
						<span class="settings-item-name">${h.name}</span>
						<span class="settings-item-meta">${h.username ? `${h.username}@` : ""}${h.host}${h.port ? `:${h.port}` : ""}${h.keyPath ? " (key)" : ""}</span>
					</div>
					<div class="settings-item-actions">
						<button class="modal-btn icon-btn modal-btn-danger" title="Remove" disabled=${busy} onClick=${async () => {
							if (await confirm(`Remove host "${h.name}"?`)) act(`/ssh remove ${h.name}`);
						}}><${icons.trash} /></button>
					</div>
				</div>
			`,
				)}
			${(!data || data.length === 0) && html`<div class="settings-hint">No SSH hosts configured.</div>`}
			<div class="settings-section-title">Add host</div>
			<div class="settings-ssh-form">
				<div class="settings-form-row">
					<input type="text" placeholder="name" value=${name} onInput=${(e) => setName(e.target.value)} />
					<input type="text" placeholder="host or IP" value=${host} onInput=${(e) => setHost(e.target.value)} />
				</div>
				<div class="settings-form-row">
					<input type="text" placeholder="username" value=${username} onInput=${(e) => setUsername(e.target.value)} />
					<input type="text" placeholder="port" value=${port} style=${{ maxWidth: "80px" }} onInput=${(e) => setPort(e.target.value)} />
				</div>
				<textarea class="settings-textarea" placeholder="Paste SSH private key (optional)" onInput=${(e) => setKeyContent(e.target.value)} rows="4">${keyContent}</textarea>
				<div class="settings-form-row" style=${{ justifyContent: "flex-end" }}>
					<button class="modal-btn icon-btn" title="Add SSH host" disabled=${busy || !name || !host} onClick=${async () => {
						let kp = "-";
						if (keyContent.trim()) {
							const res = await api("POST", "/api/ssh/key", { name, key: keyContent.trim() });
							if (!res?.ok) {
								alert(res?.error || "Failed to save key");
								return;
							}
							kp = res.path;
						}
						const parts = [name, host, username || "-", port || "-", kp];
						await act(`/ssh add ${parts.join(" ")}`);
						setName("");
						setHost("");
						setUsername("");
						setPort("");
						setKeyContent("");
					}}><${icons.plus} /></button>
				</div>
			</div>
		</div>
	`;
}

function Sidebar({
	sessions,
	activeId,
	personas,
	cwd,
	onSelectSession,
	onCreateSession,
	onCloseSession,
	onOpenDirPicker,
	onRenameSession,
	onPinSession,
	open,
}) {
	const [personaOpen, setPersonaOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [editingId, setEditingId] = useState(null);
	const [editValue, setEditValue] = useState("");
	const editInputRef = useRef(null);

	// Pinned is its own group above a divider (a deliberate, manual choice —
	// it shouldn't just be one more sort key mixed into the rest). Within
	// each group, running floats to the top (that's the "control room" — see
	// what's actually working), then most-recently-active.
	const byRunningThenDate = (a, b) => {
		const runningA = a.status === "running" ? 1 : 0;
		const runningB = b.status === "running" ? 1 : 0;
		if (runningA !== runningB) return runningB - runningA;
		return a.updatedAt < b.updatedAt ? 1 : -1;
	};
	const q = search.trim().toLowerCase();
	const filtered = sessions.filter(
		(s) =>
			!q ||
			(s.title ?? "").toLowerCase().includes(q) ||
			s.persona.toLowerCase().includes(q) ||
			s.model.toLowerCase().includes(q),
	);
	const pinnedGroup = filtered.filter((s) => s.pinned).sort(byRunningThenDate);
	const otherGroup = filtered.filter((s) => !s.pinned).sort(byRunningThenDate);

	const active = sessions.find((s) => s.id === activeId);

	const startEdit = useCallback((s) => {
		setEditingId(s.id);
		setEditValue(s.title || s.persona || "");
	}, []);
	const commitEdit = useCallback(() => {
		if (editingId) onRenameSession(editingId, editValue);
		setEditingId(null);
	}, [editingId, editValue, onRenameSession]);

	// Focus only when entering edit mode (a stable ref + effect keyed on
	// editingId), not on every keystroke — a callback ref re-invoked each
	// render would re-focus/reset the cursor on every character typed.
	useEffect(() => {
		if (editingId && editInputRef.current) {
			editInputRef.current.focus();
			editInputRef.current.select();
		}
	}, [editingId]);

	const renderItem = (s) => html`
		<div key=${s.id} class="sidebar-item${s.id === activeId ? " active" : ""}" title=${s.cwd} onClick=${() => onSelectSession(s.id)}>
			<span class="sidebar-item-status ${s.status || "idle"}" />
			<button
				class="sidebar-item-pin${s.pinned ? " pinned" : ""}"
				title=${s.pinned ? "Unpin" : "Pin to top"}
				onClick=${(e) => {
					e.stopPropagation();
					onPinSession(s.id, !s.pinned);
				}}
			>
				<${icons.bookmark} />
			</button>
			${
				editingId === s.id
					? html`
					<input
						ref=${editInputRef}
						class="sidebar-item-name-input"
						value=${editValue}
						onClick=${(e) => e.stopPropagation()}
						onInput=${(e) => setEditValue(e.target.value)}
						onKeyDown=${(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								commitEdit();
							}
							if (e.key === "Escape") {
								e.preventDefault();
								setEditingId(null);
							}
						}}
						onBlur=${commitEdit}
					/>
				`
					: html`<span class="sidebar-item-name" onDblClick=${(e) => {
							e.stopPropagation();
							startEdit(s);
						}}>${s.title || s.persona || "unknown"}</span>`
			}
			<span class="sidebar-item-meta">${s.messageCount} msg</span>
			<button
				class="sidebar-item-rename"
				title="Rename"
				aria-label="Rename"
				onClick=${(e) => {
					e.stopPropagation();
					startEdit(s);
				}}
			><${icons.pencil} /></button>
			<button
				class="sidebar-item-close"
				title=${s.status === "running" ? "Stop and close" : "Close"}
				aria-label="Close"
				onClick=${(e) => {
					e.stopPropagation();
					onCloseSession(s.id);
				}}
			><${icons.xMark} /></button>
		</div>
	`;

	return html`
		<nav class="sidebar${open ? " open" : ""}">
			<div class="sidebar-new-section">
				<button class="new-session-btn" onClick=${() => setPersonaOpen(!personaOpen)}>+ New session</button>
				<div class="persona-list${personaOpen ? " open" : ""}">
					<div class="dir-row">
						<span class="dir-row-label">Directory</span>
						<button class="dir-row-value" title=${cwd} onClick=${onOpenDirPicker}>${shortPath(cwd)}</button>
					</div>
					${personas.map(
						(p) => html`
						<div key=${p.name} class="persona-item" onClick=${() => {
							onCreateSession(p.name, cwd);
							setPersonaOpen(false);
						}}>
							${p.label}
							<span class="persona-label">${p.source}</span>
						</div>
					`,
					)}
				</div>
			</div>
			<div class="sidebar-divider" />
			<div class="sidebar-scroll">
				<div class="sidebar-section">
					<div class="sidebar-section-title">Sessions</div>
					${
						sessions.length > 4 &&
						html`
						<input
							class="sidebar-search"
							type="text"
							placeholder="Search sessions..."
							value=${search}
							onInput=${(e) => setSearch(e.target.value)}
						/>
					`
					}
					${
						pinnedGroup.length > 0 &&
						html`
						<div class="sidebar-group-label">Pinned</div>
						${pinnedGroup.map(renderItem)}
						<div class="sidebar-group-divider" />
					`
					}
					${otherGroup.map(renderItem)}
					${pinnedGroup.length === 0 && otherGroup.length === 0 && html`<div class="sidebar-empty">No sessions match "${search}"</div>`}
				</div>
			</div>
			${
				active &&
				html`
				<div class="sidebar-footer" title=${active.cwd}>
					<span class="sidebar-footer-status ${active.status || "idle"}" />
					<span class="sidebar-footer-model">${active.model}</span>
				</div>
			`
			}
		</nav>
	`;
}

// ── App (root) ───────────────────────────────────────────────────────

function App() {
	const [sessions, setSessions] = useState([]);
	const [activeId, setActiveId] = useState(null);
	const [session, setSession] = useState(null);
	const [personas, setPersonas] = useState([]);
	const [commands, setCommands] = useState([]);
	const [themes, setThemes] = useState([]);
	const [currentThemeId, setCurrentThemeId] = useState(null);
	const [streaming, setStreaming] = useState([]);
	const [running, setRunning] = useState(false);
	const [pendingSteers, setPendingSteers] = useState([]);
	const [pendingQueue, setPendingQueue] = useState([]);
	const [diffOpen, setDiffOpen] = useState(false);
	const [diffData, setDiffData] = useState(null);
	const [diffFile, setDiffFile] = useState(null);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [diffWidth, setDiffWidth] = useState(null);
	const [toasts, setToasts] = useState([]);
	const [connected, setConnected] = useState(true);
	const [atBottom, setAtBottom] = useState(true);
	const [defaultCwd, setDefaultCwd] = useState("");
	const [selectedCwd, setSelectedCwd] = useState(null);
	const [dirPickerOpen, setDirPickerOpen] = useState(false);
	const [hotkeysOpen, setHotkeysOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	// Settings' destructive actions (uninstall/remove/delete) need a Yes/No
	// gate. A single piece of state here — rather than one per callsite —
	// means one confirm modal, styled like the rest of the app instead of
	// the browser's native confirm(), reused by every "are you sure?" button.
	const [confirmState, setConfirmState] = useState(null);
	const requestConfirm = useCallback((message) => new Promise((resolve) => setConfirmState({ message, resolve })), []);
	const cwd = selectedCwd ?? defaultCwd ?? "";

	// Sessions the user explicitly closed (the × button) stay hidden from
	// this browser's sidebar even though the backend now shows every
	// persisted session ever saved (see bridge.ts's listSessions) — closing
	// is a per-browser "declutter", not a delete, and re-opening one by URL
	// (a shared link, browser history) un-hides it again.
	const [dismissedIds, setDismissedIds] = useState(() => {
		try {
			return new Set(JSON.parse(localStorage.getItem("cast:dismissedSessions") || "[]"));
		} catch {
			return new Set();
		}
	});
	const dismiss = useCallback((id) => {
		setDismissedIds((prev) => {
			const next = new Set(prev);
			next.add(id);
			try {
				localStorage.setItem("cast:dismissedSessions", JSON.stringify([...next]));
			} catch {}
			return next;
		});
	}, []);
	const undismiss = useCallback((id) => {
		setDismissedIds((prev) => {
			if (!prev.has(id)) return prev;
			const next = new Set(prev);
			next.delete(id);
			try {
				localStorage.setItem("cast:dismissedSessions", JSON.stringify([...next]));
			} catch {}
			return next;
		});
	}, []);

	const esRef = useRef(null);
	const messagesRef = useRef(null);
	const autoScrollRef = useRef(true);
	const selfClosingRef = useRef(null);
	const reconnectTimerRef = useRef(null);
	const wasRunningRef = useRef(false);
	const [reconnectNonce, setReconnectNonce] = useState(0);

	// Live stopwatch — ticks while running, freezes on stop. Per-session
	// start times survive thread switches so the display is correct when
	// you come back to a still-running session.
	const turnStartRef = useRef(new Map());
	const [elapsedMs, setElapsedMs] = useState(0);
	useEffect(() => {
		if (running && connected) {
			if (!turnStartRef.current.has(activeId)) turnStartRef.current.set(activeId, Date.now());
			const id = setInterval(() => {
				const start = turnStartRef.current.get(activeId);
				if (start) setElapsedMs(Date.now() - start);
			}, 100);
			return () => clearInterval(id);
		} else if (!running) {
			// Freeze the display for 5s after the run ends, then hide.
			const timeout = setTimeout(() => setElapsedMs(0), 5000);
			return () => clearTimeout(timeout);
		}
		// Disconnected while running — freeze the timer at the last known
		// value instead of counting up with a stale connection. When the SSE
		// reconnects (connected→true) the interval resumes from the real
		// start time; if the run ended server-side while offline, the next
		// `end` event will transition to the "not running" branch.
	}, [running, activeId, connected]);

	// Toast helper — stacks; each entry removes itself after 4s.
	const showToast = useCallback((text, type = "info") => {
		const id = `${Date.now()}-${Math.random()}`;
		setToasts((prev) => [...prev, { id, text, type }]);
		setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
	}, []);

	// Command feedback belongs in the permanent transcript, not a 4-second
	// toast — role "warning" (not "system") since the real system-prompt
	// message at messages[0] is role:"system" and gets filtered from view.
	const addNotice = useCallback((text, role = "warning") => {
		setSession((prev) => (prev ? { ...prev, messages: [...prev.messages, { role, content: text }] } : prev));
	}, []);

	// Load sessions
	const loadSessions = useCallback(async () => {
		try {
			const data = await api("GET", "/api/sessions");
			setSessions(data);
		} catch {}
	}, []);

	// Select session — `push` controls whether this lands as a new browser
	// history entry (a real click) or just replaces the current URL
	// (programmatic: initial bootstrap, reconnect recovery, popstate).
	const selectSession = useCallback(
		async (id, { push = true } = {}) => {
			try {
				const data = await api("GET", `/api/sessions/${id}`);
				setSession(data);
				setActiveId(id);
				setStreaming([]);
				setRunning(data.status === "running");
				wasRunningRef.current = data.status === "running";
				setSidebarOpen(false);
				try {
					localStorage.setItem("cast:lastSessionId", id);
				} catch {}
				setUrlSessionId(id, { push });
				undismiss(id);
			} catch (err) {
				showToast(err.message, "error");
			}
		},
		[showToast, undismiss],
	);

	// Create session — the POST already returns the full new (empty) session,
	// so apply it directly instead of two more round trips (list + refetch)
	// before anything shows up.
	const createSession = useCallback(
		async (persona, cwd, { push = true } = {}) => {
			try {
				const data = await api("POST", "/api/sessions", { persona, cwd });
				setActiveId(data.id);
				setSession({
					id: data.id,
					persona: data.session.persona,
					model: data.session.model,
					cwd: data.session.cwd,
					status: "idle",
					messages: [],
					usage: data.session.usage,
					createdAt: data.session.createdAt,
					updatedAt: data.session.updatedAt,
				});
				setStreaming([]);
				setRunning(false);
				setSidebarOpen(false);
				try {
					localStorage.setItem("cast:lastSessionId", data.id);
				} catch {}
				setUrlSessionId(data.id, { push });
				loadSessions();
			} catch (err) {
				showToast(err.message, "error");
			}
		},
		[loadSessions, showToast],
	);

	// Full client bootstrap — personas/commands/themes/config, then sessions,
	// landing on whichever one was last active (see selectSession's
	// localStorage write). Used on first mount AND to recover after the
	// backend goes away and comes back (see startReconnectLoop below):
	// sessions live only in-memory server-side, so a backend restart loses
	// every one of them, and re-running this exact sequence is what lets the
	// page keep working without a manual reload once it's back.
	const initClientState = useCallback(async () => {
		try {
			const p = await api("GET", "/api/personas");
			if (!p) return false;
			const sortedPersonas = [...p].sort((a, b) => a.label.localeCompare(b.label));
			setPersonas(sortedPersonas);
			api("GET", "/api/commands")
				.then((c) => c && setCommands(c))
				.catch(() => {});
			api("GET", "/api/themes")
				.then((t) => {
					if (!t) return;
					setThemes(t);
					api("GET", "/api/config")
						.then((cfg) => {
							if (!cfg) return;
							setDefaultCwd(cfg.cwd ?? "");
							const current = t.find((x) => x.id === cfg.theme) ?? t.find((x) => x.id === "cast");
							if (current) {
								applyTheme(current.colors);
								setCurrentThemeId(current.id);
							}
						})
						.catch(() => {});
				})
				.catch(() => {});

			const s = await api("GET", "/api/sessions");
			if (!s) return false;
			setSessions(s);
			if (s.length > 0) {
				// URL wins (lets a shared/duplicated/bookmarked link always land on
				// that exact thread) over the last-active fallback from localStorage.
				const urlId = sessionIdFromUrl();
				let lastId = null;
				try {
					lastId = localStorage.getItem("cast:lastSessionId");
				} catch {}
				const target =
					urlId && s.find((x) => x.id === urlId)
						? urlId
						: lastId && s.find((x) => x.id === lastId)
							? lastId
							: s[0].id;
				await selectSession(target, { push: false });
			} else {
				const defaultP = sortedPersonas.find((x) => x.name === "coding") ?? sortedPersonas[0];
				if (defaultP) await createSession(defaultP.name, undefined, { push: false });
			}
			return true;
		} catch {
			return false;
		}
	}, [selectSession, createSession]);

	// The browser's own EventSource retry only covers a connection that
	// dropped after connecting fine (network blip, laptop sleep) — it does
	// NOT retry when the very first request comes back non-2xx (readyState
	// goes straight to CLOSED), which is exactly what happens when the
	// backend restarts: every session lived only in memory, so the old
	// session id 404s forever. This polls until the backend responds again,
	// then re-bootstraps and bumps reconnectNonce so the SSE effect below
	// re-subscribes even if selectSession happens to land back on the same id.
	const startReconnectLoop = useCallback(() => {
		if (reconnectTimerRef.current) return;
		// Set synchronously, before the first async attempt even starts — a
		// dropped connection can fire `onerror` more than once in a row (each
		// EventSource the SSE effect spins up during recovery has its own),
		// and without a guard that's set immediately, two overlapping retry
		// loops can each see "no sessions yet" and each create their own
		// default session (a real duplicate-session race, caught in testing).
		reconnectTimerRef.current = "pending";
		const tryOnce = async () => {
			const ok = await initClientState();
			if (ok) {
				reconnectTimerRef.current = null;
				setReconnectNonce((n) => n + 1);
			} else {
				reconnectTimerRef.current = setTimeout(tryOnce, 3000);
			}
		};
		tryOnce();
	}, [initClientState]);

	// Close (stop) a session — aborts it server-side if running and drops it
	// from the live list. History stays on disk; it just stops being a tab.
	const closeSession = useCallback(
		async (id) => {
			// The DELETE also broadcasts session_closed over this same session's SSE
			// connection, which can arrive before this fetch resolves — mark it as
			// self-initiated so that handler doesn't flash a spurious error toast.
			if (id === activeId) selfClosingRef.current = id;
			try {
				await api("DELETE", `/api/sessions/${id}`);
			} catch (err) {
				showToast(err.message, "error");
				return;
			}
			// The backend still lists this session (still on disk) — closing only
			// unloads it from the live runner, not the disk file — so hiding it
			// from view is purely this browser's own dismissed-set, not something
			// removed from `sessions` itself.
			dismiss(id);
			if (id !== activeId) return;

			if (esRef.current) {
				esRef.current.close();
				esRef.current = null;
			}
			const remaining = sessions.filter((s) => s.id !== id && !dismissedIds.has(s.id));
			if (remaining.length > 0) {
				await selectSession(remaining[0].id, { push: false });
				return;
			}
			setActiveId(null);
			setSession(null);
			setStreaming([]);
			const defaultP = personas.find((x) => x.name === "coding") ?? personas[0];
			if (defaultP) await createSession(defaultP.name, undefined, { push: false });
		},
		[sessions, activeId, personas, selectSession, createSession, showToast, dismiss, dismissedIds],
	);

	// Rename — overrides the auto-derived-from-first-message title. Updates
	// the sidebar list optimistically instead of waiting on a full refetch.
	const renameSession = useCallback(
		async (id, title) => {
			try {
				const data = await api("POST", `/api/sessions/${id}/rename`, { title });
				setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title: data?.title } : s)));
				if (id === activeId) setSession((prev) => (prev ? { ...prev, title: data?.title } : prev));
			} catch (err) {
				showToast(err.message, "error");
			}
		},
		[activeId, showToast],
	);

	const pinSession = useCallback(
		async (id, pinned) => {
			try {
				const data = await api("POST", `/api/sessions/${id}/pin`, { pinned });
				setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, pinned: data?.pinned } : s)));
			} catch (err) {
				showToast(err.message, "error");
			}
		},
		[showToast],
	);

	// Sidebar toggle — a drawer on mobile (existing transform-based behavior),
	// a collapsible grid column on desktop (same button, different meaning).
	const toggleSidebar = useCallback(() => {
		if (window.innerWidth <= 768) setSidebarOpen((v) => !v);
		else setSidebarCollapsed((v) => !v);
	}, []);

	// Opening the diff panel on a mid-width viewport leaves too little room for
	// the chat column otherwise — auto-collapse the sidebar to compensate. Only
	// on open, and only if the user hasn't already dealt with it; closing diff
	// doesn't force the sidebar back (that'd fight a manual re-expand).
	const toggleDiff = useCallback(() => {
		setDiffOpen((v) => {
			const next = !v;
			if (next && window.innerWidth > 768 && window.innerWidth < 1200) setSidebarCollapsed(true);
			return next;
		});
	}, []);

	// Diff panel drag-to-resize — pointer events so mouse and touch both work.
	const dragStateRef = useRef(null);
	const onDiffResizeMove = useCallback((e) => {
		const st = dragStateRef.current;
		if (!st) return;
		const delta = st.startX - e.clientX;
		const next = Math.min(Math.max(st.startWidth + delta, 320), Math.round(window.innerWidth * 0.85));
		setDiffWidth(next);
	}, []);
	const onDiffResizeEnd = useCallback(() => {
		dragStateRef.current = null;
		document.body.classList.remove("resizing-diff");
		window.removeEventListener("pointermove", onDiffResizeMove);
	}, [onDiffResizeMove]);
	const startDiffResize = useCallback(
		(e) => {
			e.preventDefault();
			const panel = document.querySelector(".diff-panel");
			dragStateRef.current = {
				startX: e.clientX,
				startWidth: panel?.getBoundingClientRect().width ?? diffWidth ?? 560,
			};
			document.body.classList.add("resizing-diff");
			window.addEventListener("pointermove", onDiffResizeMove);
			window.addEventListener("pointerup", onDiffResizeEnd, { once: true });
		},
		[diffWidth, onDiffResizeMove, onDiffResizeEnd],
	);

	// Submit message
	const submitMessage = useCallback(
		async (text) => {
			if (!activeId) {
				// Composer is disabled while !ready, so this only fires on a very
				// fast Enter right as the page loads — surface it instead of eating
				// the message silently.
				showToast("Still connecting — try again in a moment", "error");
				return;
			}
			if (text.startsWith("/")) {
				// Client-only commands — no round trip to the agent session.
				if (text === "/diff") {
					toggleDiff();
					return;
				}
				if (text === "/copy") {
					const lastAssistant = [...(session?.messages ?? [])].reverse().find((m) => m.role === "assistant");
					if (!lastAssistant) {
						addNotice("Nothing to copy yet");
						return;
					}
					// Live-flushed messages carry `blocks`, not a flat `content` string —
					// copy the reply text only (skip reasoning/tool blocks).
					const text2 = Array.isArray(lastAssistant.blocks)
						? lastAssistant.blocks
								.filter((b) => b.kind === "content")
								.map((b) => b.text)
								.join("")
						: typeof lastAssistant.content === "string"
							? lastAssistant.content
							: JSON.stringify(lastAssistant.content);
					try {
						if (navigator.clipboard) {
							await navigator.clipboard.writeText(text2);
						} else {
							// HTTP fallback — Clipboard API unavailable outside secure contexts.
							const ta = document.createElement("textarea");
							ta.value = text2;
							ta.style.cssText = "position:fixed;opacity:0";
							document.body.appendChild(ta);
							ta.select();
							document.execCommand("copy");
							document.body.removeChild(ta);
						}
						addNotice("Copied to clipboard");
					} catch {
						addNotice("Copy failed", "error");
					}
					return;
				}
				try {
					const result = await api("POST", `/api/sessions/${activeId}/command`, { command: text });
					if (text === "/sessions") await loadSessions();
					if (text.startsWith("/new") && result?.result?.sessionId) {
						await loadSessions();
						await selectSession(result.result.sessionId);
						return; // now viewing the fresh session — nothing to append a notice to
					}
					if (text === "/clear" && session) {
						setSession({ ...session, messages: [] });
						return; // context just got wiped — nothing left to append a notice to
					}
					if (text.startsWith("/persona") && result?.result?.persona) {
						setSession((prev) => (prev ? { ...prev, persona: result.result.persona } : prev));
						await loadSessions();
						addNotice(`Persona: ${result.result.label ?? result.result.persona}`);
					} else if (text.startsWith("/model") && result?.result?.model) {
						setSession((prev) => (prev ? { ...prev, model: result.result.model } : prev));
						await loadSessions();
						addNotice(`Model: ${result.result.model}`);
					} else if (text.startsWith("/theme") && result?.result?.theme) {
						if (result.result.colors) applyTheme(result.result.colors);
						setCurrentThemeId(result.result.theme);
						addNotice(`Theme: ${result.result.label ?? result.result.theme}`);
					} else if (text.startsWith("/current") && result?.result) {
						const r = result.result;
						addNotice(`${r.persona} · ${r.model} · ${r.status} · ${r.messageCount} msg`);
					} else if (text.startsWith("/usage") && result?.result) {
						const u = result.result;
						const cost = u.cost ? ` · $${u.cost.toFixed(4)}` : "";
						addNotice(
							`${u.totalTokens ?? 0} tokens (${u.promptTokens ?? 0} in / ${u.completionTokens ?? 0} out)${cost}`,
						);
					} else if (text === "/sessions" && Array.isArray(result?.result)) {
						addNotice(`${result.result.length} session${result.result.length === 1 ? "" : "s"}`);
					} else if (text.startsWith("/repo") && result?.result) {
						const r = result.result;
						addNotice(
							r.isGit ? `${r.cwd} · ${r.branch}${r.dirty ? " (dirty)" : ""}` : `${r.cwd} — not a git repository`,
						);
					} else if (text.startsWith("/reasoning") && result?.result) {
						const r = result.result;
						addNotice(
							r.note ??
								`Reasoning: ${r.reasoningLevel}${r.options?.length ? ` (options: ${r.options.join(", ")})` : ""}`,
						);
					} else if (text.startsWith("/web") && result?.result && "webTools" in result.result) {
						addNotice(`Web tools: ${result.result.webTools ? "enabled" : "disabled"}`);
					} else if ((text.startsWith("/steer") || text.startsWith("/s ")) && result?.ok) {
						const msg = text.replace(/^\/(steer|s)\s*/, "");
						if (msg) setPendingSteers((prev) => [...prev, msg]);
						addNotice(result.result);
					} else if ((text.startsWith("/queue") || text.startsWith("/q ")) && result?.ok) {
						const msg = text.replace(/^\/(queue|q)\s*/, "");
						if (msg) setPendingQueue((prev) => [...prev, msg]);
						addNotice(result.result);
					} else if ((text === "/plan" || text === "/build") && result?.ok) {
						const mode = text === "/plan" ? "plan" : "build";
						setSession((prev) => (prev ? { ...prev, mode } : prev));
						addNotice(result.result);
					} else if (result?.result && typeof result.result === "string") {
						addNotice(result.result);
					} else if (result?.result && typeof result.result === "object") {
						// Fallback so an object/array result is never silently swallowed —
						// this exact gap (POST succeeds, nothing visible) is what made
						// /current, /usage, and /sessions look completely broken before.
						addNotice(JSON.stringify(result.result));
					}
				} catch (err) {
					addNotice(err.message, "error");
				}
				return;
			}
			// Show the message immediately — waiting for the POST to resolve before
			// appending it made every send feel like it had a beat of lag, even
			// though the round trip to localhost is fast.
			setSession((prev) =>
				prev ? { ...prev, messages: [...prev.messages, { role: "user", content: text }] } : prev,
			);
			turnStartRef.current.delete(activeId);
			setElapsedMs(0);
			try {
				await api("POST", `/api/sessions/${activeId}/chat`, { text });
				// Picks up the auto-derived title after a session's first message
				// (and keeps the sidebar's message counts from drifting stale).
				loadSessions();
			} catch (err) {
				showToast(err.message, "error");
			}
		},
		[activeId, session, loadSessions, selectSession, showToast, toggleDiff, addNotice],
	);

	// Abort
	const abortRun = useCallback(async () => {
		if (!activeId) return;
		try {
			await api("POST", `/api/sessions/${activeId}/abort`);
		} catch {}
		setSession((prev) =>
			prev ? { ...prev, messages: [...prev.messages, { role: "warning", content: "Run aborted" }] } : prev,
		);
	}, [activeId]);

	// Load diff — always the full multi-file diff. Selecting a file in the
	// list (setDiffFile below) just changes which of the already-fetched
	// files is shown; it must never re-fetch a single-file diff, since that
	// response would replace the whole list with just that one entry (and
	// for a file git treats as binary, with none at all — "picking a file
	// makes everything disappear").
	const loadDiff = useCallback(async () => {
		if (!activeId) return;
		try {
			setDiffData(await api("GET", `/api/sessions/${activeId}/diff`));
		} catch {
			setDiffData({ files: [] });
		}
	}, [activeId]);

	// SSE
	// biome-ignore lint/correctness/useExhaustiveDependencies: reconnectNonce isn't read in the body — bumping it is what forces this effect to re-subscribe after a backend restart (see startReconnectLoop).
	useEffect(() => {
		if (!activeId) return;
		if (esRef.current) esRef.current.close();

		const es = new EventSource(`${window.location.origin}/api/sessions/${activeId}/events`);
		esRef.current = es;
		setConnected(true);

		es.onopen = () => setConnected(true);

		es.onmessage = (e) => {
			try {
				const event = JSON.parse(e.data);
				switch (event.type) {
					case "status": {
						const isRunning = event.status === "running";
						setRunning(isRunning);
						setSession((prev) => (prev ? { ...prev, status: event.status } : prev));
						// If the run ended between our initial GET and the SSE
						// connect, we missed the `end` event. The `session_end`
						// event (which follows `status: idle`) carries usage and
						// messageCount — it handles the refetch when counts diverge.
						wasRunningRef.current = isRunning;
						break;
					}
					case "token":
						setStreaming((prev) => {
							const last = prev[prev.length - 1];
							if (last && last.kind === "content")
								return [...prev.slice(0, -1), { kind: "content", text: last.text + event.text }];
							return [...prev, { kind: "content", text: event.text }];
						});
						break;
					case "thinking":
						setStreaming((prev) => {
							const last = prev[prev.length - 1];
							if (last && last.kind === "thinking")
								return [...prev.slice(0, -1), { kind: "thinking", text: last.text + event.text }];
							return [...prev, { kind: "thinking", text: event.text }];
						});
						break;
					case "tool_start":
						setStreaming((prev) => [
							...prev,
							{ kind: "tool", call: { id: event.id, name: event.name, args: event.args, status: "running" } },
						]);
						break;
					case "tool_end":
						setStreaming((prev) =>
							prev.map((b) =>
								b.kind === "tool" && b.call.id === event.id
									? {
											...b,
											call: {
												...b.call,
												status: event.result?.isError ? "error" : "ok",
												result: event.result?.content?.slice(0, 4000) ?? "",
											},
										}
									: b,
							),
						);
						if (diffOpen) loadDiff();
						break;
					case "assistant_message":
						// Keep reasoning, prose, and tool calls as separate ordered blocks
						// (mirrors the TUI's [reasoning]/[agent] rows) instead of flattening
						// them into one string — otherwise a turn's thinking text silently
						// merges into the visible reply with no label or distinction.
						setStreaming((prevStreaming) => {
							setSession((prev) => {
								if (!prev) return prev;
								if (prevStreaming.length === 0) return prev;
								const msg = { role: "assistant", blocks: prevStreaming };
								return { ...prev, messages: [...prev.messages, msg] };
							});
							return [];
						});
						break;
					case "end":
						setStreaming([]);
						setRunning(false);
						setSession((prev) => (prev ? { ...prev, status: "idle" } : prev));
						setPendingSteers([]);
						setPendingQueue([]);
						break;
					case "session_end":
						setSession((prev) => {
							if (!prev) return prev;
							// If the client already has all messages from SSE streaming
							// (normal uninterrupted run), just apply usage — skip the
							// full refetch. Only refetch when message counts diverge
							// (mid-run reconnect where SSE events were missed).
							if (event.messageCount === prev.messages.length) {
								return { ...prev, usage: event.usage };
							}
							// Reconnect recovery: pull full messages from server.
							api("GET", `/api/sessions/${activeId}`)
								.then((d) => {
									if (!d) return;
									setSession((inner) => {
										if (!inner) return inner;
										const serverMsgs = d.messages || [];
										const clientHasBlocks = inner.messages.some(
											(m) => Array.isArray(m.blocks) && m.blocks.length > 0,
										);
										const messages =
											serverMsgs.length > inner.messages.length || !clientHasBlocks
												? serverMsgs
												: inner.messages;
										return { ...inner, messages, usage: d.usage, updatedAt: d.updatedAt };
									});
								})
								.catch(() => {});
							return { ...prev, usage: event.usage };
						});
						break;
					case "error":
						setStreaming([]);
						setRunning(false);
						setSession((prev) =>
							prev
								? {
										...prev,
										status: "error",
										messages: [
											...prev.messages,
											{ role: "error", content: event.message ?? "Unknown error" },
										],
									}
								: prev,
						);
						break;
					case "session_update":
						setSessions((prev) => prev.map((s) => (s.id === event.session.id ? { ...s, ...event.session } : s)));
						break;
					case "compaction":
						setSession((prev) =>
							prev
								? {
										...prev,
										messages: [
											...prev.messages,
											{ role: "system", content: `Context compacted (${event.messagesCompacted} messages)` },
										],
									}
								: prev,
						);
						break;
					case "doom_loop":
						setSession((prev) =>
							prev
								? {
										...prev,
										messages: [
											...prev.messages,
											{
												role: "warning",
												content: `Doom loop: ${event.tool} called ${event.attempts} times`,
											},
										],
									}
								: prev,
						);
						break;
					case "steering_injected":
					case "followup_injected": {
						// Promote streaming to history first, then show injected messages.
						setStreaming((prevStreaming) => {
							setSession((prev) => {
								if (!prev) return prev;
								const msgs =
									prevStreaming.length > 0
										? [...prev.messages, { role: "assistant", blocks: prevStreaming }]
										: prev.messages;
								const injected = event.messages.map((m) => ({
									role: "user",
									content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
								}));
								return { ...prev, messages: [...msgs, ...injected] };
							});
							return [];
						});
						if (event.type === "steering_injected") {
							setPendingSteers((p) => p.slice(event.messages.length));
						} else {
							setPendingQueue((p) => p.slice(event.messages.length));
						}
						break;
					}
					case "interrupt_reminder":
						setSession((prev) =>
							prev
								? {
										...prev,
										messages: [
											...prev.messages,
											{ role: "warning", content: "Context restored after interrupt" },
										],
									}
								: prev,
						);
						break;
					case "date_rollover":
						setSession((prev) =>
							prev
								? {
										...prev,
										messages: [
											...prev.messages,
											{ role: "warning", content: `Date rolled over to ${event.date}` },
										],
									}
								: prev,
						);
						break;
					case "open_work_gate":
						addNotice(`Plan steps still open — continuing (attempt ${event.fires})`);
						break;
					case "open_work_gate_exhausted":
						addNotice("Plan steps still open — max retries reached, ending turn");
						break;
					case "session_closed":
						// Reached if this session was closed by another client/tab —
						// a self-initiated close clears the flag instead of toasting.
						if (selfClosingRef.current === activeId) {
							selfClosingRef.current = null;
						} else {
							showToast("This session was closed", "error");
						}
						break;
				}
			} catch {}
		};

		// The browser's native EventSource retries on its own for a connection
		// that drops after connecting fine — we just reflect that outage in the
		// UI until a fresh "open" fires. But readyState === CLOSED means it's
		// given up for good (the initial/reconnect request itself came back
		// non-2xx, e.g. this session id no longer exists after a backend
		// restart) and needs our own recovery loop instead.
		es.onerror = () => {
			setConnected(false);
			if (es.readyState === EventSource.CLOSED) {
				setSession((prev) =>
					prev
						? { ...prev, messages: [...prev.messages, { role: "warning", content: "Connection terminated" }] }
						: prev,
				);
				startReconnectLoop();
			}
		};

		return () => {
			es.close();
		};
	}, [activeId, reconnectNonce, startReconnectLoop, addNotice, loadDiff, showToast, diffOpen]);

	// Auto-scroll
	// biome-ignore lint/correctness/useExhaustiveDependencies: session?.messages/streaming aren't read in the body — they're the triggers to re-scroll whenever new content arrives, read indirectly via the DOM refs instead.
	useEffect(() => {
		if (autoScrollRef.current && messagesRef.current) {
			requestAnimationFrame(() => {
				messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
			});
		}
	}, [session?.messages, streaming]);

	const scrollToBottom = useCallback(() => {
		autoScrollRef.current = true;
		setAtBottom(true);
		if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
	}, []);

	// Scroll detection
	const handleScroll = useCallback(() => {
		const el = messagesRef.current;
		if (!el) return;
		const bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
		autoScrollRef.current = bottom;
		setAtBottom(bottom);
	}, []);

	// Toggle diff — reset the selected file so switching sessions (or
	// reopening) doesn't leave a stale selection that no longer matches any
	// file in the freshly loaded list.
	useEffect(() => {
		if (diffOpen && activeId) {
			setDiffFile(null);
			loadDiff();
		}
	}, [diffOpen, activeId, loadDiff]);

	// Init
	// biome-ignore lint/correctness/useExhaustiveDependencies: deliberately mount-only — initClientState's own identity can change across renders, and re-running the full bootstrap on that would fight startReconnectLoop's manual retries.
	useEffect(() => {
		initClientState();
	}, []);

	// Back/forward through browser history moves between sessions too, since
	// each one now has its own URL — don't push a new entry for this or
	// clicking back would just move forward again.
	useEffect(() => {
		const onPopState = () => {
			const id = sessionIdFromUrl();
			if (id) selectSession(id, { push: false });
		};
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, [selectSession]);

	// Global hotkeys
	useEffect(() => {
		const onKey = (e) => {
			if (e.key === "Escape" && hotkeysOpen) {
				setHotkeysOpen(false);
				return;
			}
			if (e.key === "Escape" && dirPickerOpen) {
				setDirPickerOpen(false);
				return;
			}

			// Ctrl/Cmd combos. Plain Ctrl+D/N/L are reserved by Chrome/Firefox
			// (bookmark, new window, focus address bar) and never reach page
			// JS at all, so those actions use Ctrl+Shift instead.
			const mod = e.ctrlKey || e.metaKey;
			if (mod && !e.shiftKey && e.key === "b") {
				e.preventDefault();
				setSidebarCollapsed((v) => !v);
				return;
			}
			if (mod && e.shiftKey && e.key === "D") {
				e.preventDefault();
				toggleDiff();
				return;
			}
			if (mod && e.shiftKey && e.key === "N") {
				e.preventDefault();
				const p = personas.find((x) => x.name === "coding") ?? personas[0];
				if (p) createSession(p.name, cwd);
				return;
			}
			if (mod && e.shiftKey && e.key === "L") {
				e.preventDefault();
				if (activeId) submitMessage("/clear");
				return;
			}
			if (mod && !e.shiftKey && e.key === "/") {
				e.preventDefault();
				setHotkeysOpen((v) => !v);
				return;
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [hotkeysOpen, dirPickerOpen, activeId, personas, cwd, createSession, submitMessage, toggleDiff]);

	const messages = session?.messages?.filter((m) => m.role !== "system") || [];
	// Each thread can run under a different persona — shown right above the
	// composer (not the header, which is shared chrome) so it's always clear
	// which role a message is about to go to, especially when switching
	// between sessions that don't share one.
	const activePersonaLabel = session
		? (personas.find((p) => p.name === session.persona)?.label ?? session.persona)
		: null;
	// The backend lists every persisted session (see bridge.ts), but a
	// closed one should stay out of view in this browser until re-opened by
	// URL/history — see dismiss()/undismiss() above.
	const visibleSessions = sessions.filter((s) => !dismissedIds.has(s.id));

	// Which meaning of the toggle applies depends on viewport (drawer on
	// mobile, collapsible column on desktop) — read at render time, same as
	// toggleSidebar's own check, so the chevron always matches the layout
	// it's about to flip.
	const sidebarVisible = typeof window !== "undefined" && window.innerWidth <= 768 ? sidebarOpen : !sidebarCollapsed;

	const appStyle = {};
	if (sidebarCollapsed) appStyle["--sidebar-col"] = "0px";
	if (diffOpen && diffWidth) appStyle["--diff-w"] = `${diffWidth}px`;

	// Hotkeys modal — rendered via dangerouslySetInnerHTML to avoid htm/h() issues.
	const hotkeysModalRef = useModalFocusTrap(hotkeysOpen);
	const hotkeysModal =
		hotkeysOpen &&
		html`
		<div class="modal-backdrop" onClick=${() => setHotkeysOpen(false)}>
			<div class="modal modal-hotkeys" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" tabIndex="-1" ref=${hotkeysModalRef} onClick=${(e) => e.stopPropagation()}>
				<div class="modal-header">
					<span>Keyboard shortcuts</span>
					<button class="modal-close" onClick=${() => setHotkeysOpen(false)} aria-label="Close"><${icons.xMark} /></button>
				</div>
				<div class="hotkeys-list" dangerouslySetInnerHTML=${{ __html: hotkeysHtml }}></div>
			</div>
		</div>
	`;

	const closeConfirm = (result) => {
		confirmState?.resolve(result);
		setConfirmState(null);
	};
	const confirmModalRef = useModalFocusTrap(!!confirmState);
	const confirmModal =
		confirmState &&
		html`
		<div class="modal-backdrop" onClick=${() => closeConfirm(false)}>
			<div class="modal modal-confirm" role="alertdialog" aria-modal="true" aria-label="Confirm" tabIndex="-1" ref=${confirmModalRef} onClick=${(e) => e.stopPropagation()}>
				<div class="modal-confirm-body">${confirmState.message}</div>
				<div class="modal-footer">
					<button class="modal-btn" onClick=${() => closeConfirm(false)}>Cancel</button>
					<button class="modal-btn modal-btn-danger" onClick=${() => closeConfirm(true)}>Confirm</button>
				</div>
			</div>
		</div>
	`;

	return html`
		<div class="app${diffOpen ? " with-diff" : ""}${sidebarCollapsed ? " sidebar-collapsed" : ""}" style=${appStyle}>
			<!-- Toasts -->
			<div class="toast-stack">
				${toasts.map(
					(t) => html`
					<div key=${t.id} class="toast toast-${t.type}">${t.text}</div>
				`,
				)}
			</div>

			<!-- Header -->
			<header class="header">
				<button class="menu-toggle${sidebarVisible ? " active" : " collapsed"}" onClick=${toggleSidebar} aria-label=${sidebarVisible ? "Collapse sessions" : "Expand sessions"}>
					<${icons.chevronRight} class="chevron-icon" />
				</button>
				<span class="header-logo">cast</span>
				${!connected && html`<span class="conn-pill">reconnecting…</span>`}
				<div class="header-right">
					${activeId && html`<${StatusPopover} activeId=${activeId} running=${running} />`}
					<button class="menu-toggle" onClick=${() => setSettingsOpen(true)} aria-label="Settings" title="Settings">
						<${icons.settings} />
					</button>
					<button class="menu-toggle hotkeys-toggle" onClick=${() => setHotkeysOpen(true)} aria-label="Keyboard shortcuts" title=${`Shortcuts (${modKey}/)`}>
						<${icons.help} />
					</button>
					<button class="menu-toggle diff-toggle${diffOpen ? " active" : ""}" onClick=${toggleDiff} aria-label=${diffOpen ? "Close diff panel" : "Open diff panel"} title="Diff">
						<${icons.chevronLeft} class="chevron-icon" />
					</button>
				</div>
			</header>

			<!-- Sidebar backdrop (mobile) -->
			<div class="sidebar-backdrop${sidebarOpen ? " visible" : ""}" onClick=${() => setSidebarOpen(false)} />

			<${Sidebar}
				sessions=${visibleSessions}
				activeId=${activeId}
				personas=${personas}
				cwd=${cwd}
				onSelectSession=${selectSession}
				onCreateSession=${createSession}
				onCloseSession=${closeSession}
				onOpenDirPicker=${() => setDirPickerOpen(true)}
				onRenameSession=${renameSession}
				onPinSession=${pinSession}
				open=${sidebarOpen}
			/>

			<!-- Directory picker — rendered here (not inside Sidebar) because
			     .sidebar gets a CSS transform for its mobile drawer slide, and a
			     transformed ancestor becomes the containing block for any
			     position:fixed descendant, trapping the modal inside the
			     sidebar's own box on narrow screens instead of centering over the
			     whole viewport. -->
			${
				dirPickerOpen &&
				html`
				<${DirectoryBrowser}
					initialPath=${cwd}
					onPick=${(p) => {
						setSelectedCwd(p);
						setDirPickerOpen(false);
					}}
					onClose=${() => setDirPickerOpen(false)}
				/>
			`
			}

			${hotkeysModal}

			${
				settingsOpen &&
				activeId &&
				html`
				<${SettingsModal}
					activeId=${activeId}
					themes=${themes}
					currentThemeId=${currentThemeId}
					onApplyTheme=${applyTheme}
					onThemeChange=${setCurrentThemeId}
					onClose=${() => setSettingsOpen(false)}
					confirm=${requestConfirm}
				/>
			`
			}

			<!-- Rendered after SettingsModal (not before) so its backdrop paints
			     on top and actually receives clicks — the confirm prompt is only
			     ever triggered from inside a settings tab, so it must outrank it
			     in DOM/paint order. -->
			${confirmModal}

			<!-- Chat area -->
			<main class="chat-area">
				<div class="messages" ref=${messagesRef} onScroll=${handleScroll}>
					${
						messages.length === 0 &&
						streaming.length === 0 &&
						html`
						<div class="empty-state">
							<pre class="empty-state-banner">${CAST_BANNER}</pre>
							<p class="empty-state-title">Ready when you are</p>
							<p class="empty-state-hint">Send a message, or type <code>/</code> to see what this agent can do.</p>
						</div>
					`
					}
					${messages.map((msg, i) => html`<${Message} key=${i} msg=${msg} />`)}
					<${StreamingBlocks} blocks=${streaming} />
				</div>
				${
					!atBottom &&
					html`
					<button class="scroll-bottom-btn" onClick=${scrollToBottom} aria-label="Scroll to latest">
						<${icons.chevronDown} />
					</button>
				`
				}
				${
					activePersonaLabel &&
					html`
					<div class="composer-role">
						<div class="composer-role-left">
							${activePersonaLabel}
							${session?.mode && session.mode !== "build" && html`<span class="composer-role-mode">${session.mode}</span>`}
						</div>
						${elapsedMs > 0 && html`<span class="composer-elapsed">${(elapsedMs / 1000).toFixed(1)}s</span>`}
					</div>
				`
				}
				${
					(pendingSteers.length > 0 || pendingQueue.length > 0) &&
					html`
					<div class="pending-items">
						${pendingSteers.map(
							(text, i) => html`
							<div key=${`steer-${i}`} class="pending-item pending-steer">
								<span class="pending-label">Steer${pendingSteers.length > 1 ? ` (${i + 1}/${pendingSteers.length})` : ""}:</span> ${text}
							</div>
						`,
						)}
						${pendingQueue.map(
							(text, i) => html`
							<div key=${`queue-${i}`} class="pending-item pending-queue">
								<span class="pending-label">Queued${pendingQueue.length > 1 ? ` (${i + 1}/${pendingQueue.length})` : ""}:</span> ${text}
							</div>
						`,
						)}
					</div>
				`
				}
				<${Composer} running=${running} ready=${!!activeId} commands=${commands} personas=${personas} onSubmit=${submitMessage} onAbort=${abortRun} />
			</main>

			<!-- Diff — a wide right sidebar alongside the chat on desktop, a
			     full-screen overlay on mobile (see the max-width:768px rules).
			     Always mounted (like Sidebar) so the open/close is a pure CSS
			     class/transform transition instead of a mount with no "from"
			     state to animate out of. -->
			${
				activeId &&
				html`
				<${DiffPanel} data=${diffData} activeFile=${diffFile} onSelectFile=${setDiffFile} onClose=${() => setDiffOpen(false)} onResizeStart=${startDiffResize} open=${diffOpen} />
			`
			}
		</div>
	`;
}

// ── Mount ────────────────────────────────────────────────────────────
render(html`<${App} />`, document.getElementById("app"));
