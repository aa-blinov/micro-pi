/**
 * cast web — Preact + htm client application.
 * No build step: importmap loads preact and htm from esm.sh CDN.
 */

import { h, render } from "preact";
import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

// ── API ──────────────────────────────────────────────────────────────
async function api(method, path, body) {
	const opts = { method, headers: {} };
	if (body !== undefined) {
		opts.headers["Content-Type"] = "application/json";
		opts.body = JSON.stringify(body);
	}
	const res = await fetch(path, opts);
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
	let src = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
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

// Full parameter dump, not a truncated hint \u2014 the point is to see exactly
// what the agent is about to run, not just enough to guess.
function formatArgsFull(args) {
	if (!args) return "";
	try {
		const obj = JSON.parse(args);
		const entries = Object.entries(obj);
		if (entries.length === 0) return "";
		return entries.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`).join("\n");
	} catch {
		return args;
	}
}

function shortPath(p) {
	if (!p) return "";
	const parts = p.split("/").filter(Boolean);
	if (parts.length <= 2) return p;
	return "\u2026/" + parts.slice(-2).join("/");
}

const WEB_TOOLS_OPTIONS = [
	{ value: "on", label: "Enable web_search / web_fetch" },
	{ value: "off", label: "Disable web_search / web_fetch" },
];

// \u2500\u2500 URL routing \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// A query param, not a path segment (`/s/:id`) \u2014 the server's static file
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

function ToolCard({ call }) {
	// Shows what the agent is calling — full input parameters — and whether
	// it's still running / succeeded / failed. Deliberately no result body:
	// the point of this card is the request, not the (often huge) output.
	const statusClass = call.status || "running";
	const args = formatArgsFull(call.args);
	return html`
		<div class="tool-card">
			<div class="tool-card-header" data-tool=${call.name}>
				<span class="tool-card-name">${call.name}</span>
				<span class="tool-card-status ${statusClass}" />
			</div>
			${args && html`<div class="tool-card-body">${args}</div>`}
		</div>
	`;
}

function Message({ msg }) {
	const role = msg.role || "assistant";
	if (role === "tool") return null;

	const labelMap = { user: "you", agent: "agent", assistant: "agent", system: "system", warning: "notice", error: "error" };

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
	const content = typeof msg.content === "string" ? msg.content : msg.content == null ? "" : JSON.stringify(msg.content);

	if (role === "assistant") {
		return html`
			<div class="message-group">
				${msg.thinking && html`
					<div class="message message-reasoning">
						<div class="message-label">reasoning</div>
						<div class="message-content">${msg.thinking}</div>
					</div>
				`}
				${msg.toolCalls && msg.toolCalls.map((tc) => html`<${ToolCard} key=${tc.id} call=${tc} />`)}
				${content && html`
					<div class="message message-assistant">
						<div class="message-label">agent</div>
						<div class="message-content" dangerouslySetInnerHTML=${{ __html: renderMarkdown(content) }} />
					</div>
				`}
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
			${items.map((it, i) => html`
				<div key=${it.value} class="cmd-item${i === selectedIndex ? " selected" : ""}" onMouseEnter=${() => onHover(i)} onClick=${() => onSelect(it.value)}>
					<span class="cmd-name">${it.value}</span>
					<span class="cmd-desc">${it.label}</span>
				</div>
			`)}
		</div>
	`;
}

function Composer({ running, ready, activeId, commands, personas, themes, onSubmit, onAbort }) {
	const [value, setValue] = useState("");
	const [cmdVisible, setCmdVisible] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const textareaRef = useRef(null);
	const pickerRef = useRef(null);

	const personaMatch = /^\/persona\s+(\S*)$/i.exec(value);
	const themeMatch = /^\/theme\s+(\S*)$/i.exec(value);
	const modelMatch = /^\/model\s+(\S*)$/i.exec(value);
	const reasoningMatch = /^\/reasoning\s+(\S*)$/i.exec(value);
	const webMatch = /^\/web\s+(\S*)$/i.exec(value);
	const suggestMatch = /^\/(mcp|skills|plugin|provider|ssh|permissions|subagent-model|plan-model)\s+(\S*)$/i.exec(value);

	// Both lazy-loaded (only worth a network round trip once the user is
	// actually typing that command) and re-fetched whenever the picker they
	// feed is opened again — a model switch or a live provider model list
	// shouldn't require a page reload to show up.
	const [models, setModels] = useState(null);
	const [reasoningOptions, setReasoningOptions] = useState(null);
	const [suggestions, setSuggestions] = useState(null);
	useEffect(() => {
		if (!modelMatch || models !== null) return;
		let cancelled = false;
		api("GET", "/api/models").then((d) => { if (!cancelled && d) setModels(d.models || []); }).catch(() => {});
		return () => { cancelled = true; };
	}, [Boolean(modelMatch), models]);
	useEffect(() => {
		if (!reasoningMatch || !activeId || reasoningOptions !== null) return;
		let cancelled = false;
		api("GET", `/api/sessions/${activeId}/reasoning-options`).then((d) => { if (!cancelled && d) setReasoningOptions(d.options || []); }).catch(() => {});
		return () => { cancelled = true; };
	}, [Boolean(reasoningMatch), activeId, reasoningOptions]);
	// Switching sessions (a different model) invalidates any reasoning
	// options fetched for the previous one.
	useEffect(() => { setReasoningOptions(null); }, [activeId]);

	// Reset suggestions when the typed command shifts (e.g. /mcp enable → /mcp disable).
	const suggestKey = suggestMatch ? suggestMatch[0] : null;
	const prevSuggestKey = useRef(null);
	useEffect(() => {
		if (suggestKey !== prevSuggestKey.current) {
			setSuggestions(null);
			prevSuggestKey.current = suggestKey;
		}
	}, [suggestKey]);
	useEffect(() => {
		if (!suggestMatch || !activeId || suggestions !== null) return;
		let cancelled = false;
		api("GET", `/api/suggest?q=${encodeURIComponent(value)}&session=${activeId}`)
			.then((d) => { if (!cancelled && d) setSuggestions(d); })
			.catch(() => {});
		return () => { cancelled = true; };
	}, [Boolean(suggestMatch), activeId, value, suggestions]);

	const resize = useCallback(() => {
		const el = textareaRef.current;
		if (el) {
			el.style.height = "auto";
			el.style.height = Math.min(el.scrollHeight, 150) + "px";
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

	const handleCmdSelect = useCallback((name) => {
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
		setValue(name + " ");
		setCmdVisible(false);
		textareaRef.current?.focus();
		requestAnimationFrame(resize);
	}, [commands, onSubmit, resize]);

	const handlePersonaSelect = useCallback((name) => {
		onSubmit(`/persona ${name}`);
		setValue("");
		if (textareaRef.current) textareaRef.current.style.height = "auto";
	}, [onSubmit]);

	const handleThemeSelect = useCallback((id) => {
		onSubmit(`/theme ${id}`);
		setValue("");
		if (textareaRef.current) textareaRef.current.style.height = "auto";
	}, [onSubmit]);

	const handleModelSelect = useCallback((id) => {
		onSubmit(`/model ${id}`);
		setValue("");
		if (textareaRef.current) textareaRef.current.style.height = "auto";
	}, [onSubmit]);

	const handleReasoningSelect = useCallback((level) => {
		onSubmit(`/reasoning ${level}`);
		setValue("");
		if (textareaRef.current) textareaRef.current.style.height = "auto";
	}, [onSubmit]);

	const handleWebSelect = useCallback((v) => {
		onSubmit(`/web ${v}`);
		setValue("");
		if (textareaRef.current) textareaRef.current.style.height = "auto";
	}, [onSubmit]);

	const handleGenericSuggest = useCallback((v) => {
		onSubmit(value.replace(/\s+\S*$/, ` ${v}`));
		setValue("");
	}, [value, onSubmit]);

	const handleInput = useCallback((e) => {
		const val = e.target.value;
		setValue(val);
		setCmdVisible(val.startsWith("/") && !val.includes(" "));
		setSelectedIndex(0);
		resize();
	}, [resize]);

	// One active picker at a time — Composer owns the filtered list and the
	// selection index so arrow keys and mouse clicks act on the exact same
	// row order, whichever picker happens to be showing. Persona/theme/model/
	// reasoning/web all normalize to {value, label} so ValueSuggest can
	// render any of them the same way.
	let pickerItems = [];
	let pickerSelect = null;
	if (personaMatch) {
		pickerItems = personas
			.filter((p) => p.name.toLowerCase().startsWith(personaMatch[1].toLowerCase()))
			.map((p) => ({ value: p.name, label: p.label }));
		pickerSelect = handlePersonaSelect;
	} else if (themeMatch) {
		pickerItems = themes
			.filter((t) => t.id.toLowerCase().startsWith(themeMatch[1].toLowerCase()))
			.map((t) => ({ value: t.id, label: t.label }));
		pickerSelect = handleThemeSelect;
	} else if (modelMatch) {
		const q = modelMatch[1].toLowerCase();
		pickerItems = (models || [])
			.filter((m) => m.id.toLowerCase().includes(q))
			.map((m) => ({ value: m.id, label: m.reasoning ? `${m.id} · reasoning` : m.id }));
		pickerSelect = handleModelSelect;
	} else if (reasoningMatch) {
		const q = reasoningMatch[1].toLowerCase();
		pickerItems = (reasoningOptions || []).filter((o) => o.value.toLowerCase().startsWith(q));
		pickerSelect = handleReasoningSelect;
	} else if (webMatch) {
		const q = webMatch[1].toLowerCase();
		pickerItems = WEB_TOOLS_OPTIONS.filter((o) => o.value.startsWith(q));
		pickerSelect = handleWebSelect;
	} else if (suggestMatch) {
		const q = suggestMatch[2].toLowerCase();
		pickerItems = (suggestions || []).filter((o) => o.value.toLowerCase().startsWith(q));
		pickerSelect = handleGenericSuggest;
	} else if (cmdVisible) {
		pickerItems = value ? commands.filter((c) => c.name.startsWith(value)) : commands;
		pickerSelect = handleCmdSelect;
	}
	// Fetched lazily (see the effects above) — without this, typing "/model "
	// before the /v1/models round trip resolves just shows an empty, seemingly
	// broken picker for a moment instead of any feedback that it's working.
	const pickerLoading = (modelMatch && models === null) || (reasoningMatch && reasoningOptions === null) || (suggestMatch && suggestions === null);
	const clampedIndex = pickerItems.length > 0 ? Math.min(selectedIndex, pickerItems.length - 1) : 0;

	// Arrow-key nav must scroll the picker, not just select past the visible
	// edge — mouse/scroll-wheel already worked, but the highlighted row could
	// silently move off-screen when reached via the keyboard.
	useEffect(() => {
		pickerRef.current?.querySelector(".cmd-item.selected")?.scrollIntoView({ block: "nearest" });
	}, [clampedIndex]);

	const handleKeyDown = useCallback((e) => {
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
	}, [pickerItems, clampedIndex, pickerSelect, running, handleSubmit]);

	return html`
		<div class="composer-wrap">
			<div ref=${pickerRef}>
				${pickerLoading
					? html`<div class="cmd-palette open"><div class="cmd-item cmd-loading">Loading…</div></div>`
					: (personaMatch || themeMatch || modelMatch || reasoningMatch || webMatch || suggestMatch)
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
				${running
					? html`<button class="composer-abort" onClick=${onAbort} aria-label="Abort"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor"/></svg></button>`
					: html`<button class="composer-send" onClick=${handleSubmit} disabled=${!ready || !value.trim()} aria-label="Send"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M14 2L7 9M14 2L9.5 14L7 9M14 2L2 6.5L7 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
				}
			</div>
		</div>
	`;
}

function DiffPanel({ data, activeFile, onSelectFile, onClose, onResizeStart }) {
	if (!data) return html`
		<aside class="diff-panel open">
			<div class="diff-resize-handle" onPointerDown=${onResizeStart} />
			<div class="diff-empty">Loading...</div>
		</aside>
	`;

	const files = data.files || [];
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
				if (line.type === "+") { num = addN; addN++; }
				else if (line.type === "-") { num = delN; delN++; }
				return { key: li, typeClass, num, content: line.content };
			});
			return { hi, hunk, lines };
		});
	}

	return html`
		<aside class="diff-panel open">
			<div class="diff-resize-handle" onPointerDown=${onResizeStart} />
			<div class="diff-header">
				<span class="diff-title">Changes</span>
				<button class="diff-close" onClick=${onClose}>×</button>
			</div>
			<div class="diff-file-list">
				${files.map((f) => html`
					<div key=${f.path} class="diff-file-item${f.path === (activeFile || file?.path) ? " active" : ""}" onClick=${() => onSelectFile(f.path)}>
						<span>${f.path.split("/").pop()}</span>
						<span class="diff-file-stats">
							<span class="add">+${f.additions}</span>
							<span class="del">-${f.deletions}</span>
						</span>
					</div>
				`)}
			</div>
			<div class="diff-view">
				${diffContent
					? diffContent.map((h) => html`
						<div key=${h.hi}>
							<div class="diff-hunk-header">@@ -${h.hunk.oldStart},${h.hunk.oldLines} +${h.hunk.newStart},${h.hunk.newLines} @@</div>
							${h.lines.map((l) => html`
								<div key=${l.key} class="diff-line ${l.typeClass}">
									<span class="diff-line-num">${l.num}</span>
									<span class="diff-line-content">${l.content}</span>
								</div>
							`)}
						</div>
					`)
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

	useEffect(() => { load(initialPath); }, []);

	return html`
		<div class="modal-backdrop" onClick=${onClose}>
			<div class="modal" onClick=${(e) => e.stopPropagation()}>
				<div class="modal-header">
					<span>Choose working directory</span>
					<button class="modal-close" onClick=${onClose} aria-label="Close">×</button>
				</div>
				<div class="dir-path" title=${path}>${path}</div>
				<div class="dir-list">
					${parent !== null && html`
						<div class="dir-item dir-item-up" onClick=${() => load(parent)}>.. (parent directory)</div>
					`}
					${entries.map((e) => html`
						<div key=${e.path} class="dir-item" onClick=${() => load(e.path)}>${e.name}</div>
					`)}
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

function Sidebar({ sessions, activeId, personas, cwd, onSelectSession, onCreateSession, onCloseSession, onOpenDirPicker, onRenameSession, onPinSession, open }) {
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
	const filtered = sessions.filter((s) =>
		!q || (s.title ?? "").toLowerCase().includes(q) || s.persona.toLowerCase().includes(q) || s.model.toLowerCase().includes(q)
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
				onClick=${(e) => { e.stopPropagation(); onPinSession(s.id, !s.pinned); }}
			>
				<svg width="11" height="11" viewBox="0 0 16 16" fill="none"><rect x="3.5" y="7" width="9" height="7" rx="1.3" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
			</button>
			${editingId === s.id
				? html`
					<input
						ref=${editInputRef}
						class="sidebar-item-name-input"
						value=${editValue}
						onClick=${(e) => e.stopPropagation()}
						onInput=${(e) => setEditValue(e.target.value)}
						onKeyDown=${(e) => {
							if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
							if (e.key === "Escape") { e.preventDefault(); setEditingId(null); }
						}}
						onBlur=${commitEdit}
					/>
				`
				: html`<span class="sidebar-item-name" onDblClick=${(e) => { e.stopPropagation(); startEdit(s); }}>${s.title || s.persona || "unknown"}</span>`
			}
			<span class="sidebar-item-meta">${s.messageCount} msg</span>
			<button
				class="sidebar-item-rename"
				title="Rename"
				onClick=${(e) => { e.stopPropagation(); startEdit(s); }}
			>✎</button>
			<button
				class="sidebar-item-close"
				title=${s.status === "running" ? "Stop and close" : "Close"}
				onClick=${(e) => { e.stopPropagation(); onCloseSession(s.id); }}
			>×</button>
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
					${personas.map((p) => html`
						<div key=${p.name} class="persona-item" onClick=${() => { onCreateSession(p.name, cwd); setPersonaOpen(false); }}>
							${p.label}
							<span class="persona-label">${p.source}</span>
						</div>
					`)}
				</div>
			</div>
			<div class="sidebar-divider" />
			<div class="sidebar-scroll">
				<div class="sidebar-section">
					<div class="sidebar-section-title">Sessions</div>
					${sessions.length > 4 && html`
						<input
							class="sidebar-search"
							type="text"
							placeholder="Search sessions..."
							value=${search}
							onInput=${(e) => setSearch(e.target.value)}
						/>
					`}
					${pinnedGroup.length > 0 && html`
						<div class="sidebar-group-label">Pinned</div>
						${pinnedGroup.map(renderItem)}
						<div class="sidebar-group-divider" />
					`}
					${otherGroup.map(renderItem)}
					${pinnedGroup.length === 0 && otherGroup.length === 0 && html`<div class="sidebar-empty">No sessions match "${search}"</div>`}
				</div>
			</div>
			${active && html`
				<div class="sidebar-footer" title=${active.cwd}>
					<span class="sidebar-footer-status ${active.status || "idle"}" />
					<span class="sidebar-footer-model">${active.model}</span>
				</div>
			`}
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
	const cwd = selectedCwd ?? defaultCwd ?? "";

	// Sessions the user explicitly closed (the × button) stay hidden from
	// this browser's sidebar even though the backend now shows every
	// persisted session ever saved (see bridge.ts's listSessions) — closing
	// is a per-browser "declutter", not a delete, and re-opening one by URL
	// (a shared link, browser history) un-hides it again.
	const [dismissedIds, setDismissedIds] = useState(() => {
		try { return new Set(JSON.parse(localStorage.getItem("cast:dismissedSessions") || "[]")); } catch { return new Set(); }
	});
	const dismiss = useCallback((id) => {
		setDismissedIds((prev) => {
			const next = new Set(prev);
			next.add(id);
			try { localStorage.setItem("cast:dismissedSessions", JSON.stringify([...next])); } catch {}
			return next;
		});
	}, []);
	const undismiss = useCallback((id) => {
		setDismissedIds((prev) => {
			if (!prev.has(id)) return prev;
			const next = new Set(prev);
			next.delete(id);
			try { localStorage.setItem("cast:dismissedSessions", JSON.stringify([...next])); } catch {}
			return next;
		});
	}, []);

	const esRef = useRef(null);
	const messagesRef = useRef(null);
	const autoScrollRef = useRef(true);
	const selfClosingRef = useRef(null);
	const reconnectTimerRef = useRef(null);
	const [reconnectNonce, setReconnectNonce] = useState(0);

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
	const selectSession = useCallback(async (id, { push = true } = {}) => {
		try {
			const data = await api("GET", `/api/sessions/${id}`);
			setSession(data);
			setActiveId(id);
			setStreaming([]);
			setRunning(data.status === "running");
			setSidebarOpen(false);
			try { localStorage.setItem("cast:lastSessionId", id); } catch {}
			setUrlSessionId(id, { push });
			undismiss(id);
		} catch (err) {
			showToast(err.message, "error");
		}
	}, [showToast, undismiss]);

	// Create session — the POST already returns the full new (empty) session,
	// so apply it directly instead of two more round trips (list + refetch)
	// before anything shows up.
	const createSession = useCallback(async (persona, cwd, { push = true } = {}) => {
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
			try { localStorage.setItem("cast:lastSessionId", data.id); } catch {}
			setUrlSessionId(data.id, { push });
			loadSessions();
		} catch (err) {
			showToast(err.message, "error");
		}
	}, [loadSessions, showToast]);

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
			api("GET", "/api/commands").then((c) => c && setCommands(c)).catch(() => {});
			api("GET", "/api/themes").then((t) => {
				if (!t) return;
				setThemes(t);
				api("GET", "/api/config").then((cfg) => {
					if (!cfg) return;
					setDefaultCwd(cfg.cwd ?? "");
					const current = t.find((x) => x.id === cfg.theme) ?? t.find((x) => x.id === "cast");
					if (current) applyTheme(current.colors);
				}).catch(() => {});
			}).catch(() => {});

			const s = await api("GET", "/api/sessions");
			if (!s) return false;
			setSessions(s);
			if (s.length > 0) {
				// URL wins (lets a shared/duplicated/bookmarked link always land on
				// that exact thread) over the last-active fallback from localStorage.
				const urlId = sessionIdFromUrl();
				let lastId = null;
				try { lastId = localStorage.getItem("cast:lastSessionId"); } catch {}
				const target = (urlId && s.find((x) => x.id === urlId))
					? urlId
					: (lastId && s.find((x) => x.id === lastId)) ? lastId : s[0].id;
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
	const closeSession = useCallback(async (id) => {
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

		if (esRef.current) { esRef.current.close(); esRef.current = null; }
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
	}, [sessions, activeId, personas, selectSession, createSession, showToast, dismiss, dismissedIds]);

	// Rename — overrides the auto-derived-from-first-message title. Updates
	// the sidebar list optimistically instead of waiting on a full refetch.
	const renameSession = useCallback(async (id, title) => {
		try {
			const data = await api("POST", `/api/sessions/${id}/rename`, { title });
			setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title: data?.title } : s)));
			if (id === activeId) setSession((prev) => (prev ? { ...prev, title: data?.title } : prev));
		} catch (err) {
			showToast(err.message, "error");
		}
	}, [activeId, showToast]);

	const pinSession = useCallback(async (id, pinned) => {
		try {
			const data = await api("POST", `/api/sessions/${id}/pin`, { pinned });
			setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, pinned: data?.pinned } : s)));
		} catch (err) {
			showToast(err.message, "error");
		}
	}, [showToast]);

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
	const startDiffResize = useCallback((e) => {
		e.preventDefault();
		const panel = document.querySelector(".diff-panel");
		dragStateRef.current = { startX: e.clientX, startWidth: panel?.getBoundingClientRect().width ?? diffWidth ?? 560 };
		document.body.classList.add("resizing-diff");
		window.addEventListener("pointermove", onDiffResizeMove);
		window.addEventListener("pointerup", onDiffResizeEnd, { once: true });
	}, [diffWidth, onDiffResizeMove, onDiffResizeEnd]);

	// Submit message
	const submitMessage = useCallback(async (text) => {
		if (!activeId) {
			// Composer is disabled while !ready, so this only fires on a very
			// fast Enter right as the page loads — surface it instead of eating
			// the message silently.
			showToast("Still connecting — try again in a moment", "error");
			return;
		}
		if (text.startsWith("/")) {
			// Client-only commands — no round trip to the agent session.
			if (text === "/diff") { toggleDiff(); return; }
			if (text === "/copy") {
				const lastAssistant = [...(session?.messages ?? [])].reverse().find((m) => m.role === "assistant");
				if (!lastAssistant) { addNotice("Nothing to copy yet"); return; }
				// Live-flushed messages carry `blocks`, not a flat `content` string —
				// copy the reply text only (skip reasoning/tool blocks).
				const text2 = Array.isArray(lastAssistant.blocks)
					? lastAssistant.blocks.filter((b) => b.kind === "content").map((b) => b.text).join("")
					: typeof lastAssistant.content === "string" ? lastAssistant.content : JSON.stringify(lastAssistant.content);
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
					addNotice(`Theme: ${result.result.label ?? result.result.theme}`);
				} else if (text.startsWith("/current") && result?.result) {
					const r = result.result;
					addNotice(`${r.persona} · ${r.model} · ${r.status} · ${r.messageCount} msg`);
				} else if (text.startsWith("/usage") && result?.result) {
					const u = result.result;
					const cost = u.cost ? ` · $${u.cost.toFixed(4)}` : "";
					addNotice(`${u.totalTokens ?? 0} tokens (${u.promptTokens ?? 0} in / ${u.completionTokens ?? 0} out)${cost}`);
				} else if (text === "/sessions" && Array.isArray(result?.result)) {
					addNotice(`${result.result.length} session${result.result.length === 1 ? "" : "s"}`);
				} else if (text.startsWith("/repo") && result?.result) {
					const r = result.result;
					addNotice(r.isGit ? `${r.cwd} · ${r.branch}${r.dirty ? " (dirty)" : ""}` : `${r.cwd} — not a git repository`);
				} else if (text.startsWith("/reasoning") && result?.result) {
					const r = result.result;
					addNotice(r.note ?? `Reasoning: ${r.reasoningLevel}${r.options?.length ? ` (options: ${r.options.join(", ")})` : ""}`);
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
		setSession((prev) => prev ? { ...prev, messages: [...prev.messages, { role: "user", content: text }] } : prev);
		try {
			await api("POST", `/api/sessions/${activeId}/chat`, { text });
			// Picks up the auto-derived title after a session's first message
			// (and keeps the sidebar's message counts from drifting stale).
			loadSessions();
		} catch (err) {
			showToast(err.message, "error");
		}
	}, [activeId, session, loadSessions, selectSession, showToast, toggleDiff, addNotice]);

	// Abort
	const abortRun = useCallback(async () => {
		if (!activeId) return;
		try { await api("POST", `/api/sessions/${activeId}/abort`); } catch {}
	}, [activeId]);

	// SSE
	useEffect(() => {
		if (!activeId) return;
		if (esRef.current) esRef.current.close();

		const es = new EventSource(`/api/sessions/${activeId}/events`);
		esRef.current = es;
		setConnected(true);

		es.onopen = () => setConnected(true);

		es.onmessage = (e) => {
			try {
				const event = JSON.parse(e.data);
				switch (event.type) {
					case "status":
						setRunning(event.status === "running");
						setSession((prev) => prev ? { ...prev, status: event.status } : prev);
						break;
					case "token":
						setStreaming((prev) => {
							const last = prev[prev.length - 1];
							if (last && last.kind === "content") return [...prev.slice(0, -1), { kind: "content", text: last.text + event.text }];
							return [...prev, { kind: "content", text: event.text }];
						});
						break;
					case "thinking":
						setStreaming((prev) => {
							const last = prev[prev.length - 1];
							if (last && last.kind === "thinking") return [...prev.slice(0, -1), { kind: "thinking", text: last.text + event.text }];
							return [...prev, { kind: "thinking", text: event.text }];
						});
						break;
					case "tool_start":
						setStreaming((prev) => [...prev, { kind: "tool", call: { id: event.id, name: event.name, args: event.args, status: "running" } }]);
						break;
					case "tool_end":
						setStreaming((prev) => prev.map((b) =>
							b.kind === "tool" && b.call.id === event.id
								? { ...b, call: { ...b.call, status: event.result?.isError ? "error" : "ok", result: event.result?.content?.slice(0, 4000) ?? "" } }
								: b
						));
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
						setSession((prev) => prev ? { ...prev, status: "idle" } : prev);
							setPendingSteers([]);
							setPendingQueue([]);
						// Pull fresh usage numbers only — `messages` already holds this
						// turn's full reasoning/tool-call blocks from live streaming, and
						// the server's persisted form can't carry reasoning at all (it's
						// never saved to disk), so overwriting messages here would silently
						// collapse everything back down to just the final reply.
						api("GET", `/api/sessions/${activeId}`).then((d) => {
							if (d) setSession((prev) => prev ? { ...prev, usage: d.usage, updatedAt: d.updatedAt } : prev);
						}).catch(() => {});
						break;
					case "error":
						setStreaming([]);
						setRunning(false);
						setSession((prev) => prev ? { ...prev, status: "error", messages: [...prev.messages, { role: "error", content: event.message ?? "Unknown error" }] } : prev);
						break;
					case "compaction":
						setSession((prev) => prev ? { ...prev, messages: [...prev.messages, { role: "system", content: `Context compacted (${event.messagesCompacted} messages)` }] } : prev);
						break;
					case "doom_loop":
						setSession((prev) => prev ? { ...prev, messages: [...prev.messages, { role: "warning", content: `Doom loop: ${event.tool} called ${event.attempts} times` }] } : prev);
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
			if (es.readyState === EventSource.CLOSED) startReconnectLoop();
		};

		return () => { es.close(); };
	}, [activeId, reconnectNonce, startReconnectLoop]);

	// Auto-scroll
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

	const messages = session?.messages?.filter((m) => m.role !== "system") || [];
	// Each thread can run under a different persona — shown right above the
	// composer (not the header, which is shared chrome) so it's always clear
	// which role a message is about to go to, especially when switching
	// between sessions that don't share one.
	const activePersonaLabel = session ? (personas.find((p) => p.name === session.persona)?.label ?? session.persona) : null;
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

	return html`
		<div class="app${diffOpen ? " with-diff" : ""}${sidebarCollapsed ? " sidebar-collapsed" : ""}" style=${appStyle}>
			<!-- Toasts -->
			<div class="toast-stack">
				${toasts.map((t) => html`
					<div key=${t.id} class="toast toast-${t.type}">${t.text}</div>
				`)}
			</div>

			<!-- Header -->
			<header class="header">
				<button class="menu-toggle${sidebarVisible ? "" : " collapsed"}" onClick=${toggleSidebar} aria-label=${sidebarVisible ? "Collapse sessions" : "Expand sessions"}>
					<svg class="chevron-icon" width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M12.5 4l-6 6 6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
				</button>
				<span class="header-logo">cast</span>
				${!connected && html`<span class="conn-pill">reconnecting\u2026</span>`}
				<div class="header-right">
					<button class="menu-toggle diff-toggle${diffOpen ? " active" : ""}" onClick=${toggleDiff} aria-label=${diffOpen ? "Close diff panel" : "Open diff panel"} title="Diff">
						<svg class="chevron-icon" width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M7.5 4l6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
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
			${dirPickerOpen && html`
				<${DirectoryBrowser}
					initialPath=${cwd}
					onPick=${(p) => { setSelectedCwd(p); setDirPickerOpen(false); }}
					onClose=${() => setDirPickerOpen(false)}
				/>
			`}

			<!-- Chat area -->
			<main class="chat-area">
				<div class="messages" ref=${messagesRef} onScroll=${handleScroll}>
					${messages.length === 0 && streaming.length === 0 && html`
						<div class="empty-state">
							<div class="empty-state-mark">>_</div>
							<p class="empty-state-title">Ready when you are</p>
							<p class="empty-state-hint">Send a message, or type <code>/</code> to see what this agent can do.</p>
						</div>
					`}
					${messages.map((msg, i) => html`<${Message} key=${i} msg=${msg} />`)}
					<${StreamingBlocks} blocks=${streaming} />
				</div>
				${!atBottom && html`
					<button class="scroll-bottom-btn" onClick=${scrollToBottom} aria-label="Scroll to latest">
						<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 6l5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
					</button>
				`}
				${activePersonaLabel && html`
					<div class="composer-role">
						${activePersonaLabel}
						${session?.mode && session.mode !== "build" && html`<span class="composer-role-mode">${session.mode}</span>`}
					</div>
				`}
				${(pendingSteers.length > 0 || pendingQueue.length > 0) && html`
					<div class="pending-items">
						${pendingSteers.map((text, i) => html`
							<div key=${`steer-${i}`} class="pending-item pending-steer">
								<span class="pending-label">Steer${pendingSteers.length > 1 ? ` (${i + 1}/${pendingSteers.length})` : ""}:</span> ${text}
							</div>
						`)}
						${pendingQueue.map((text, i) => html`
							<div key=${`queue-${i}`} class="pending-item pending-queue">
								<span class="pending-label">Queued${pendingQueue.length > 1 ? ` (${i + 1}/${pendingQueue.length})` : ""}:</span> ${text}
							</div>
						`)}
					</div>
				`}
				<${Composer} running=${running} ready=${!!activeId} activeId=${activeId} commands=${commands} personas=${personas} themes=${themes} onSubmit=${submitMessage} onAbort=${abortRun} />
			</main>

			<!-- Diff — a wide right sidebar alongside the chat on desktop, a
			     full-screen overlay on mobile (see the max-width:768px rules). -->
			${diffOpen && html`
				<${DiffPanel} data=${diffData} activeFile=${diffFile} onSelectFile=${setDiffFile} onClose=${() => setDiffOpen(false)} onResizeStart=${startDiffResize} />
			`}
		</div>
	`;
}

// ── Mount ────────────────────────────────────────────────────────────
render(html`<${App} />`, document.getElementById("app"));
