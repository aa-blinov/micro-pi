import { readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { join, basename } from "node:path";
import { marked } from "marked";

// ── Config ──────────────────────────────────────────────────────────────────
const ROOT = new URL("..", import.meta.url).pathname;
const DOCS = join(ROOT, "docs");
const SITE = join(ROOT, "site");

const NAV_ORDER = [
	{ file: "getting-started.md", label: "Getting Started" },
	{ file: "cli-reference.md", label: "CLI Reference" },
	{ file: "interactive-commands.md", label: "Interactive Commands" },
	{ file: "tools.md", label: "Tools" },
	{ file: "personas.md", label: "Personas" },
	{ file: "skills.md", label: "Skills" },
	{ file: "rules.md", label: "Rules" },
	{ file: "mcp-servers.md", label: "MCP Servers" },
	{ file: "context-files.md", label: "Context Files" },
	{ file: "sessions.md", label: "Sessions" },
	{ file: "plan-mode.md", label: "Plan Mode" },
	{ file: "reasoning.md", label: "Reasoning" },
	{ file: "configuration.md", label: "Configuration" },
	{ file: "themes.md", label: "Themes" },
	{ file: "non-interactive-mode.md", label: "Non-Interactive Mode" },
	{ file: "architecture.md", label: "Architecture" },
	{ file: "changelog.md", label: "Changelog" },
];

// ── marked config ───────────────────────────────────────────────────────────
marked.setOptions({
	gfm: true,
	breaks: false,
});

// Custom renderer: mermaid blocks get <pre class="mermaid"> with raw code stored as base64
// Tables get wrapped in a scrollable div for mobile overflow
const renderer = new marked.Renderer();
const originalCode = renderer.code;
renderer.code = function ({ text, lang }) {
	if (lang === "mermaid") {
		const b64 = Buffer.from(text).toString("base64");
		return `<pre class="mermaid" data-raw="${b64}">${text}</pre>`;
	}
	return originalCode.call(this, { text, lang });
};
const originalTable = renderer.table;
renderer.table = function (token) {
	const header = token.header;
	const rows = token.rows;
	let html = '<div class="table-wrap"><table><thead><tr>';
	for (const cell of header) html += `<th>${marked.parseInline(cell.text)}</th>`;
	html += '</tr></thead><tbody>';
	for (const row of rows) {
		html += '<tr>';
		for (const cell of row) html += `<td>${marked.parseInline(cell.text)}</td>`;
		html += '</tr>';
	}
	html += '</tbody></table></div>';
	return html;
};

// Fix .md links to .html for site navigation
const originalLink = renderer.link;
renderer.link = function (token) {
	const href = token.href.replace(/\.md(#[^)]+)?$/, '.html$1');
	const title = token.title ? ` title="${token.title}"` : '';
	return `<a href="${href}"${title}>${token.text}</a>`;
};
marked.use({ renderer });

// ── CSS ─────────────────────────────────────────────────────────────────────
const CSS = `
:root {
	/* cast palette — cyan→violet gradient */
	--bg: #0a0e14;
	--bg-secondary: #0f1520;
	--bg-tertiary: #151c28;
	--border: #1e2a3a;
	--text: #e2e8f0;
	--text-secondary: #64748b;
	--text-muted: #475569;
	--accent: #38e0ff;
	--accent-hover: #5eead4;
	--accent-subtle: rgba(56,224,255,.1);
	--green: #34d399;
	--green-subtle: rgba(52,211,153,.1);
	--orange: #fbbf24;
	--red: #fb7185;
	--code-bg: #0f1520;
	--sidebar-w: 280px;
	--header-h: 64px;
	--font: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
	--font-mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { font-size: 16px; scroll-behavior: smooth; }
body {
	font-family: var(--font);
	background: var(--bg);
	color: var(--text);
	line-height: 1.6;
	-webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { color: var(--accent-hover); text-decoration: underline; }

/* ── Header ─────────────────────────────────────────────────────────── */
.header {
	position: fixed; top: 0; left: 0; right: 0; z-index: 100;
	height: var(--header-h);
	background: var(--bg-secondary);
	border-bottom: 1px solid var(--border);
	display: flex; align-items: center; padding: 0 24px;
}
.header-logo {
	font-size: 1.25rem; font-weight: 700; color: var(--text);
	display: flex; align-items: center; gap: 10px;
}
.header-links { margin-left: auto; display: flex; gap: 20px; align-items: center; }
.header-links a { color: var(--text-secondary); font-size: .875rem; font-weight: 500; }
.header-links a:hover { color: var(--text); text-decoration: none; }

/* ── Sidebar ────────────────────────────────────────────────────────── */
.sidebar {
	position: fixed; top: var(--header-h); left: 0; bottom: 0;
	width: var(--sidebar-w); background: var(--bg-secondary);
	border-right: 1px solid var(--border);
	overflow-y: auto; padding: 16px 0;
}
.sidebar-section { padding: 0 12px; margin-bottom: 8px; }
.sidebar-section-title {
	font-size: .75rem; font-weight: 600; text-transform: uppercase;
	letter-spacing: .05em; color: var(--text-muted);
	padding: 8px 12px 4px;
}
.sidebar a {
	display: block; padding: 6px 12px; border-radius: 6px;
	font-size: .875rem; color: var(--text-secondary); line-height: 1.4;
}
.sidebar a:hover { background: var(--bg-tertiary); color: var(--text); text-decoration: none; }
.sidebar a.active {
	background: var(--accent-subtle); color: var(--accent); font-weight: 500;
}

/* ── Mobile menu ────────────────────────────────────────────────────── */
.menu-toggle {
	display: none; background: none; border: none; color: var(--text);
	font-size: 1.5rem; cursor: pointer; padding: 4px 8px;
}
@media (max-width: 768px) {
	.sidebar {
		transform: translateX(-100%); transition: transform .2s ease;
		z-index: 99; width: 280px;
	}
	.sidebar.open { transform: translateX(0); }
	.sidebar-backdrop {
		position: fixed; inset: 0; z-index: 98;
		background: rgba(0,0,0,.5); backdrop-filter: blur(2px);
		display: none;
	}
	.sidebar-backdrop.visible { display: block; }
	.menu-toggle { display: block; margin-right: 8px; }
	.main { margin-left: 0 !important; padding: 20px 16px 60px !important; }
	.header { padding: 0 12px; }
	.header-links { gap: 14px; }

	/* Hero */
	.hero { padding: 56px 16px 40px; }
	.hero-ascii { font-size: .65rem; }
	.hero h1 { font-size: 2rem; }
	.hero p { font-size: 1rem; margin-bottom: 24px; }
	.hero-buttons a { padding: 10px 22px; font-size: .9rem; }
	.install-block { margin-top: 24px; padding: 12px 14px; }
	.install-block code { font-size: .75rem; word-break: break-all; }

	/* Features */
	.features { grid-template-columns: 1fr; padding: 24px 16px 40px; gap: 12px; }
	.feature { padding: 16px; }

	/* Providers */
	.providers { padding: 24px 16px; }
	.providers h2 { font-size: 1.25rem; }

	/* Docs grid */
	.landing-docs { padding: 24px 16px 60px; }
	.landing-docs h2 { font-size: 1.25rem; }
	.docs-grid { grid-template-columns: 1fr; }

	/* Content */
	.content h1 { font-size: 1.5rem; }
	.content h2 { font-size: 1.25rem; margin: 28px 0 10px; }
	.content h3 { font-size: 1.1rem; }
	.content table { font-size: .8rem; }
	.content th, .content td { padding: 6px 8px; }
	.content pre:not(.mermaid-code) { padding: 12px; font-size: .8rem; }

	/* Mermaid */
	.mermaid-diagram { padding: 12px; max-height: 45vh; }
	.mermaid-code { max-height: 45vh; }
	.mermaid-toolbar { padding: 6px 8px; }
	.mermaid-toolbar button { padding: 3px 8px; font-size: .75rem; }
}

/* ── Main content ───────────────────────────────────────────────────── */
.main {
	margin-left: var(--sidebar-w);
	margin-top: var(--header-h);
	padding: 32px 48px 80px;
	max-width: 900px;
}
.main-landing {
	margin-left: 0; max-width: none; padding: 0;
}

/* ── Typography ─────────────────────────────────────────────────────── */
.content h1 { font-size: 2rem; font-weight: 700; margin: 0 0 16px; line-height: 1.3; }
.content h2 {
	font-size: 1.5rem; font-weight: 600; margin: 40px 0 12px;
	padding-bottom: 8px; border-bottom: 1px solid var(--border);
}
.content h3 { font-size: 1.2rem; font-weight: 600; margin: 28px 0 8px; }
.content h4 { font-size: 1rem; font-weight: 600; margin: 20px 0 6px; }
.content p { margin: 0 0 16px; }
.content ul, .content ol { margin: 0 0 16px; padding-left: 24px; }
.content li { margin: 4px 0; }
.content strong { font-weight: 600; }
.content hr { border: none; border-top: 1px solid var(--border); margin: 32px 0; }
.content blockquote {
	border-left: 3px solid var(--accent); padding: 8px 16px;
	margin: 0 0 16px; background: var(--accent-subtle); border-radius: 0 6px 6px 0;
}
.content blockquote p:last-child { margin-bottom: 0; }

/* ── Code ───────────────────────────────────────────────────────────── */
.content code {
	font-family: var(--font-mono); font-size: .875em;
	background: var(--code-bg); padding: 2px 6px; border-radius: 4px;
	border: 1px solid var(--border);
}
.content pre:not(.mermaid-code) {
	background: var(--code-bg); border: 1px solid var(--border);
	border-radius: 8px; padding: 16px; margin: 0 0 16px;
	overflow-x: auto; line-height: 1.5;
}
.content pre:not(.mermaid-code) code {
	background: none; border: none; padding: 0; font-size: .875rem;
}

/* ── Mermaid ────────────────────────────────────────────────────────── */
.mermaid-viewer {
	background: var(--code-bg); border: 1px solid var(--border);
	border-radius: 8px; margin: 0 0 16px; overflow: hidden;
}
.mermaid-toolbar {
	display: flex; align-items: center; gap: 6px;
	padding: 8px 12px; border-bottom: 1px solid var(--border);
	background: var(--bg-tertiary);
}
.mermaid-toolbar button {
	background: var(--bg-secondary); border: 1px solid var(--border);
	color: var(--text-secondary); border-radius: 4px;
	padding: 4px 10px; font-size: .8rem; cursor: pointer;
	font-family: var(--font); line-height: 1;
}
.mermaid-toolbar button:hover { color: var(--text); border-color: var(--accent); }
.mermaid-toolbar button.active { color: var(--accent); border-color: var(--accent); }
.mermaid-toolbar .zoom-label {
	font-size: .75rem; color: var(--text-muted); margin-left: auto;
}
.mermaid-diagram {
	padding: 24px; overflow: hidden; max-height: 60vh;
	position: relative; cursor: grab; user-select: none;
	touch-action: none; -webkit-user-select: none;
}
.mermaid-diagram.dragging { cursor: grabbing; }
.mermaid-diagram svg { transition: none; transform-origin: 0 0; }
.mermaid-code {
	display: none; padding: 16px; margin: 0;
	background: none; border: none;
	font-family: var(--font-mono); font-size: .8rem;
	color: var(--text-secondary); line-height: 1.5;
	overflow-x: auto; max-height: 60vh;
}
.mermaid-code.visible { display: block; }

/* ── Tables ─────────────────────────────────────────────────────────── */
.table-wrap { overflow-x: auto; margin: 0 0 16px; border: 1px solid var(--border); border-radius: 8px; }
.content table {
	width: 100%; border-collapse: collapse; margin: 0;
	font-size: .875rem;
}
.content th, .content td {
	padding: 8px 12px; border: 1px solid var(--border); text-align: left;
}
.content th { background: var(--bg-tertiary); font-weight: 600; }
.content tr:hover td { background: var(--bg-tertiary); }

/* ── Doc page navigation ─────────────────────────────────────────────── */
.doc-nav {
	display: flex; justify-content: space-between; gap: 16px;
	margin-top: 48px; padding-top: 24px;
	border-top: 1px solid var(--border);
}
.doc-nav a {
	padding: 12px 20px; border: 1px solid var(--border); border-radius: 8px;
	font-size: .9rem; font-weight: 500; color: var(--text-secondary);
	background: var(--bg-secondary); transition: border-color .15s, color .15s;
	flex: 1;
}
.doc-nav a:hover { border-color: var(--accent); color: var(--text); text-decoration: none; }
.doc-nav-prev { text-align: left; }
.doc-nav-next { text-align: right; }
@media (max-width: 768px) {
	.doc-nav { flex-direction: column; }
	.doc-nav a { text-align: left; }
}

/* ── Landing page ───────────────────────────────────────────────────── */
.hero {
	text-align: center; padding: 100px 24px 60px;
	background: linear-gradient(180deg, var(--bg-secondary) 0%, var(--bg) 100%);
}
.hero-ascii {
	font-family: var(--font-mono); font-size: .875rem;
	white-space: pre; margin-bottom: 24px; line-height: 1.2;
	background: linear-gradient(90deg, #38e0ff, #38bdf8, #a78bfa, #a855f7);
	-webkit-background-clip: text; -webkit-text-fill-color: transparent;
	background-clip: text;
}
.hero h1 { font-size: 3rem; font-weight: 800; margin: 0 0 16px; }
.hero h1 .accent { color: #38e0ff; }
.hero p { font-size: 1.25rem; color: var(--text-secondary); max-width: 600px; margin: 0 auto 32px; }
.hero-buttons { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
.hero-buttons a {
	padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 1rem;
}
.btn-primary { background: linear-gradient(135deg, #38e0ff, #a855f7); color: #fff; }
.btn-primary:hover { background: linear-gradient(135deg, #5eead4, #c084fc); color: #fff; text-decoration: none; }
.btn-secondary {
	background: var(--bg-tertiary); color: var(--text); border: 1px solid var(--border);
}
.btn-secondary:hover { background: var(--bg-secondary); text-decoration: none; }

.install-block {
	max-width: 560px; margin: 32px auto 0; text-align: left;
	background: var(--code-bg); border: 1px solid var(--border);
	border-radius: 8px; padding: 16px 20px;
}
.install-block .label {
	font-size: .75rem; font-weight: 600; color: var(--text-muted);
	text-transform: uppercase; letter-spacing: .05em; margin-bottom: 8px;
}
.install-block code { font-size: .875rem; color: #34d399; }
.install-block .note { font-size: .8rem; color: var(--text-muted); margin-top: 8px; }

.features {
	display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
	gap: 20px; padding: 40px 48px 60px; max-width: 1200px; margin: 0 auto;
}
.feature {
	background: var(--bg-secondary); border: 1px solid var(--border);
	border-radius: 8px; padding: 24px;
}
.feature h3 { font-size: 1.1rem; margin: 0 0 8px; }
.feature p { color: var(--text-secondary); font-size: .9rem; margin: 0; }
.feature .icon { margin-bottom: 12px; display: block; color: var(--accent); }

.providers {
	text-align: center; padding: 40px 24px;
	max-width: 800px; margin: 0 auto;
}
.providers h2 { font-size: 1.5rem; margin: 0 0 24px; border: none; padding: 0; }
.provider-grid {
	display: flex; flex-wrap: wrap; gap: 12px; justify-content: center;
}
.provider-tag {
	background: var(--bg-secondary); border: 1px solid var(--border);
	padding: 8px 16px; border-radius: 6px; font-size: .875rem;
	color: var(--text-secondary); font-weight: 500;
}

.landing-docs {
	max-width: 1200px; margin: 0 auto; padding: 40px 48px 80px;
}
.landing-docs h2 {
	font-size: 1.5rem; text-align: center; margin: 0 0 32px;
	border: none; padding: 0;
}
.docs-grid {
	display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
	gap: 12px;
}
.doc-card {
	background: var(--bg-secondary); border: 1px solid var(--border);
	border-radius: 8px; padding: 16px 20px; transition: border-color .15s;
}
.doc-card:hover { border-color: var(--accent); text-decoration: none; }
.doc-card h3 { font-size: 1rem; margin: 0 0 4px; color: var(--text); }
.doc-card p { font-size: .85rem; color: var(--text-secondary); margin: 0; }

.footer {
	text-align: center; padding: 24px; border-top: 1px solid var(--border);
	font-size: .8rem; color: var(--text-muted);
}

/* ── Roles showcase ────────────────────────────────────────────────── */
.roles-showcase {
	background: var(--bg-secondary); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
	padding: 48px 24px; max-width: 900px; margin: 0 auto;
}
.roles-showcase h2 {
	text-align: center; font-size: 1.5rem; font-weight: 700; margin: 0 0 12px;
}
.roles-showcase > p {
	text-align: center; color: var(--text-secondary); max-width: 600px; margin: 0 auto 28px;
}
.roles-terminal {
	background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px;
	max-width: 560px; margin: 0 auto; overflow: hidden;
}
.roles-terminal-bar {
	display: flex; align-items: center; gap: 6px;
	padding: 10px 16px; border-bottom: 1px solid var(--border);
	background: var(--bg-tertiary);
}
.roles-terminal-bar span {
	width: 10px; height: 10px; border-radius: 50%;
}
.roles-terminal-bar span:nth-child(1) { background: #fb7185; }
.roles-terminal-bar span:nth-child(2) { background: #fbbf24; }
.roles-terminal-bar span:nth-child(3) { background: #34d399; }
.roles-terminal-body {
	font-family: var(--font-mono); font-size: .85rem; padding: 16px;
	line-height: 1.8;
}
.roles-terminal-body .prompt { color: var(--accent); }
.roles-terminal-body .cmd { color: var(--green); }
.roles-terminal-body .out { color: var(--text-secondary); }

/* ── Comparison ────────────────────────────────────────────────────── */
.comparison {
	max-width: 700px; margin: 0 auto; padding: 40px 24px 60px;
}
.comparison h2 {
	text-align: center; font-size: 1.5rem; font-weight: 700; margin: 0 0 12px;
}
.comparison > p {
	text-align: center; color: var(--text-secondary); max-width: 540px; margin: 0 auto 24px;
}
.comparison table {
	width: 100%; border-collapse: collapse;
	font-size: .875rem; background: var(--bg-secondary);
	border: 1px solid var(--border); border-radius: 8px;
	overflow: hidden;
}
.comparison th, .comparison td {
	padding: 10px 16px; border-bottom: 1px solid var(--border); text-align: left;
}
.comparison th {
	background: var(--bg-tertiary); font-weight: 600; color: var(--text);
}
.comparison td { color: var(--text-secondary); }
.comparison tr:last-child td { border-bottom: none; }

@media (max-width: 768px) {
	.roles-showcase { padding: 32px 16px; }
	.roles-terminal-body { font-size: .75rem; padding: 12px; }
	.comparison { padding: 32px 16px 48px; }
}
`;

// ── Landing page HTML ───────────────────────────────────────────────────────
const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cast — One agent, many roles</title>
<meta name="description" content="A role-based terminal agent harness. 13 built-in personas, same tools, different judgment. Runs on any OpenAI-compatible model — including the one on your own hardware.">
<style>${CSS}</style>
</head>
<body>
<header class="header">
	<a href="index.html" class="header-logo">cast</a>
	<div class="header-links">
		<a href="getting-started.html">Docs</a>
		<a href="https://github.com/aa-blinov/cast">GitHub</a>
	</div>
</header>

<div class="main main-landing">
	<section class="hero">
		<pre class="hero-ascii">                   __
  _________ ______/ /_
 / ___/ __ \`/ ___/ __/
/ /__/ /_/ (__  ) /_
\\___/\\__,_/____/\\__/</pre>
		<h1>One agent, <span class="accent">many roles</span></h1>
		<p>cast brings a full cast to your terminal: senior dev, QA, DBA, security reviewer, PM, tech writer. Swap the role, not the tool. Runs on any OpenAI-compatible model, including the one on your own hardware.</p>
		<div class="hero-buttons">
			<a href="getting-started.html" class="btn-primary">Get Started</a>
			<a href="https://github.com/aa-blinov/cast" class="btn-secondary">GitHub</a>
		</div>
		<div class="install-block">
			<div class="label">macOS / Linux</div>
			<code>curl -fsSL https://aa-blinov.github.io/cast/install | bash</code>
			<div class="label" style="margin-top:12px">Windows (PowerShell)</div>
			<code>irm https://aa-blinov.github.io/cast/install.ps1 | iex</code>
			<div class="note">Requires Node.js 18+. Self-contained bundle — no npm packages needed at runtime.</div>
		</div>
	</section>

	<section class="roles-showcase">
		<h2>One session, one repo, four roles</h2>
		<p>Same codebase, different lens. Swap personas mid-session — the tools don't change, the judgment does.</p>
		<div class="roles-terminal">
			<div class="roles-terminal-bar"><span></span><span></span><span></span></div>
			<div class="roles-terminal-body">
				<div><span class="prompt">&gt;</span> <span class="cmd">/persona pm</span></div>
				<div class="out">Write a spec for the new auth flow</div>
				<div><span class="prompt">&gt;</span> <span class="cmd">/persona coding</span></div>
				<div class="out">Implement the spec — file by file, tested</div>
				<div><span class="prompt">&gt;</span> <span class="cmd">/persona qa</span></div>
				<div class="out">Review the implementation for edge cases</div>
				<div><span class="prompt">&gt;</span> <span class="cmd">/persona tech-writer</span></div>
				<div class="out">Document the new auth flow in the README</div>
			</div>
		</div>
	</section>

	<section class="features">
		<div class="feature">
			<span class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span>
			<h3>A cast, not a coder</h3>
			<p>13 built-in personas: senior dev, QA, DBA, security reviewer, PM, tech writer, sysadmin, devops, marketer, and more. Same tools, different judgment. Add your own with a single markdown file.</p>
		</div>
		<div class="feature">
			<span class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg></span>
			<h3>Runs where your code runs</h3>
			<p>vLLM, Ollama, your own inference server, or any OpenAI-compatible API. No account, no telemetry, no cloud dependency. Your tokens stay on your hardware.</p>
		</div>
		<div class="feature">
			<span class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg></span>
			<h3>Real Tools, Real Work</h3>
			<p>Reads files, writes code, runs shell commands, searches codebases — all in parallel. Delegates sub-tasks to isolated sub-agents. Rules, skills, and MCP servers extend capabilities.</p>
		</div>
		<div class="feature">
			<span class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/></svg></span>
			<h3>Reasoning Control</h3>
			<p>Adjust reasoning effort per model: off, low, medium, high, max. Think blocks parsed automatically.</p>
		</div>
		<div class="feature">
			<span class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/></svg></span>
			<h3>Plan Mode</h3>
			<p>Explore the codebase and write execution plans before implementing. Think before you build.</p>
		</div>
		<div class="feature">
			<span class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12h12"/><path d="m12 6 6 6-6 6"/></svg></span>
			<h3>Ink TUI</h3>
			<p>A proper terminal interface with multiline paste, image attachments, smooth animations, and 16 color themes.</p>
		</div>
	</section>

	<section class="comparison">
		<h2>Why not opencode?</h2>
		<p>Both are terminal agents with tools. Different philosophy.</p>
		<table>
			<tr><th></th><th>opencode</th><th>cast</th></tr>
			<tr><td>Approach</td><td>Universal agent</td><td>Role-based harness</td></tr>
			<tr><td>Personas</td><td>Single agent, single lens</td><td>13 built-in + custom</td></tr>
			<tr><td>Self-hosted focus</td><td>Works with any provider</td><td>Designed for local inference</td></tr>
			<tr><td>Telemetry</td><td>Varies</td><td>None. Ever.</td></tr>
		</table>
	</section>

	<section class="landing-docs">
		<h2>Documentation</h2>
		<div class="docs-grid">
			${NAV_ORDER.map(
				(item) =>
					`<a href="${item.file.replace(".md", ".html")}" class="doc-card"><h3>${item.label}</h3><p>${getDescription(item.file)}</p></a>`,
			).join("\n\t\t\t")}
		</div>
	</section>

	<footer class="footer">
		cast is open source under the MIT License. Works with OpenRouter, OpenAI, Ollama, vLLM, LiteLLM, Azure OpenAI, and any OpenAI-compatible API.
	</footer>
</div>
</body>
</html>`;

// ── Doc page template ───────────────────────────────────────────────────────
function docPage(title, bodyHtml, activeFile) {
	const sidebarLinks = NAV_ORDER.map((item) => {
		const cls = item.file === activeFile ? ' class="active"' : "";
		return `\t\t\t<a href="${item.file.replace(".md", ".html")}"${cls}>${item.label}</a>`;
	}).join("\n");

	// Prev/next sequential navigation (wraps: last → first)
	const idx = NAV_ORDER.findIndex((item) => item.file === activeFile);
	const prev = idx > 0 ? NAV_ORDER[idx - 1] : NAV_ORDER[NAV_ORDER.length - 1];
	const next = idx < NAV_ORDER.length - 1 ? NAV_ORDER[idx + 1] : NAV_ORDER[0];
	const docNav = `\n\t\t<nav class="doc-nav">\n\t\t\t<a href="${prev.file.replace(".md", ".html")}" class="doc-nav-prev">← ${prev.label}</a>\n\t\t\t<a href="${next.file.replace(".md", ".html")}" class="doc-nav-next">${next.label} →</a>\n\t\t</nav>`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — cast</title>
<meta name="description" content="${title} documentation for cast, a role-based terminal agent harness.">
<style>${CSS}</style>
</head>
<body>
<header class="header">
	<button class="menu-toggle" aria-label="Menu">&#9776;</button>
	<a href="index.html" class="header-logo">cast</a>
	<div class="header-links">
		<a href="index.html">Home</a>
		<a href="https://github.com/aa-blinov/cast">GitHub</a>
	</div>
</header>

<div class="sidebar-backdrop"></div>
<nav class="sidebar">
	<div class="sidebar-section">
		<div class="sidebar-section-title">Documentation</div>
${sidebarLinks}
	</div>
</nav>

<main class="main">
	<article class="content">
		${bodyHtml}
	</article>${docNav}
</main>

<script>
// Mobile sidebar toggle with backdrop
(function() {
	const sidebar = document.querySelector('.sidebar');
	const backdrop = document.querySelector('.sidebar-backdrop');
	const toggle = document.querySelector('.menu-toggle');
	if (!toggle) return;
	function close() { sidebar.classList.remove('open'); backdrop.classList.remove('visible'); }
	function open() { sidebar.classList.add('open'); backdrop.classList.add('visible'); }
	toggle.addEventListener('click', () => {
		if (sidebar.classList.contains('open')) close(); else open();
	});
	backdrop.addEventListener('click', close);
	document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
})();
</script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>
// ── Mermaid viewer with zoom + diagram/code toggle ──
document.addEventListener('DOMContentLoaded', () => {
	const blocks = document.querySelectorAll('pre.mermaid');
	if (!blocks.length) return;

	mermaid.initialize({ startOnLoad: false, theme: 'dark' });

	blocks.forEach((pre, i) => {
		const raw = atob(pre.dataset.raw || '') || pre.textContent;

		// Build viewer shell
		const viewer = document.createElement('div');
		viewer.className = 'mermaid-viewer';

		const toolbar = document.createElement('div');
		toolbar.className = 'mermaid-toolbar';
		toolbar.innerHTML =
			'<button class="active" data-view="diagram">Diagram</button>' +
			'<button data-view="code">Code</button>' +
			'<span class="zoom-label">Zoom:</span>' +
			'<button data-zoom="out">−</button>' +
			'<button data-zoom="reset">100%</button>' +
			'<button data-zoom="in">+</button>';

		const diagram = document.createElement('div');
		diagram.className = 'mermaid-diagram';

		const code = document.createElement('pre');
		code.className = 'mermaid-code';
		code.textContent = raw;

		viewer.append(toolbar, diagram, code);
		pre.replaceWith(viewer);

		// Render mermaid
		const id = 'mermaid-' + i;
		mermaid.render(id, raw).then(({ svg }) => {
			diagram.innerHTML = svg;
		}).catch(err => {
			diagram.innerHTML = '<pre style="color:#fb7185">' + err.message + '</pre>';
		});

		// Zoom + pan state
		let zoom = 1, panX = 0, panY = 0, dragging = false, startX, startY;
		const zoomLabel = toolbar.querySelector('[data-zoom="reset"]');
		const applyTransform = () => {
			const svg = diagram.querySelector('svg');
			if (svg) svg.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
			zoomLabel.textContent = Math.round(zoom * 100) + '%';
		};

		// Drag to pan (mouse + touch)
		const getPos = e => e.touches ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY };
		const onStart = e => {
			const p = getPos(e); dragging = true;
			startX = p.x - panX; startY = p.y - panY;
			diagram.classList.add('dragging');
		};
		const onMove = e => {
			if (!dragging) return;
			const p = getPos(e);
			panX = p.x - startX; panY = p.y - startY;
			applyTransform();
		};
		const onEnd = () => { dragging = false; diagram.classList.remove('dragging'); };
	
diagram.addEventListener('mousedown', e => { onStart(e); e.preventDefault(); });
		document.addEventListener('mousemove', onMove);
		document.addEventListener('mouseup', onEnd);
		diagram.addEventListener('touchstart', e => { if (e.touches.length === 1) onStart(e); }, { passive: true });
		document.addEventListener('touchmove', e => { if (e.touches.length === 1 && dragging) onMove(e); }, { passive: true });
		document.addEventListener('touchend', onEnd);

		// Pinch to zoom (touch)
		let lastPinchDist = 0;
		diagram.addEventListener('touchstart', e => {
			if (e.touches.length === 2) {
				const dx = e.touches[0].clientX - e.touches[1].clientX;
				const dy = e.touches[0].clientY - e.touches[1].clientY;
				lastPinchDist = Math.hypot(dx, dy);
			}
		}, { passive: true });
		diagram.addEventListener('touchmove', e => {
			if (e.touches.length === 2) {
				e.preventDefault();
				const dx = e.touches[0].clientX - e.touches[1].clientX;
				const dy = e.touches[0].clientY - e.touches[1].clientY;
				const dist = Math.hypot(dx, dy);
				if (lastPinchDist > 0) {
					zoom = Math.min(3, Math.max(0.25, zoom * (dist / lastPinchDist)));
					applyTransform();
				}
				lastPinchDist = dist;
			}
		});
		diagram.addEventListener('touchend', e => { if (e.touches.length < 2) lastPinchDist = 0; });

		// Zoom + view toggle buttons
		toolbar.addEventListener('click', e => {
			const btn = e.target.closest('button');
			if (!btn) return;

			if (btn.dataset.view) {
				toolbar.querySelectorAll('[data-view]').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
				diagram.style.display = btn.dataset.view === 'diagram' ? '' : 'none';
				code.classList.toggle('visible', btn.dataset.view === 'code');
				return;
			}

			if (btn.dataset.zoom === 'in') zoom = Math.min(3, zoom + 0.25);
			else if (btn.dataset.zoom === 'out') zoom = Math.max(0.25, zoom - 0.25);
			else if (btn.dataset.zoom === 'reset') { zoom = 1; panX = 0; panY = 0; }
			applyTransform();
		});
	});
});
</script>
</body>
</html>`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function getDescription(file) {
	const descs = {
		"getting-started.md": "Install, first run, provider setup",
		"cli-reference.md": "All flags and subcommands",
		"interactive-commands.md": "All slash commands in the TUI",
		"tools.md": "Built-in tools the agent uses",
		"personas.md": "Built-in personas and custom ones",
		"skills.md": "Agent Skills spec, loading, creating",
		"rules.md": "Cursor-compatible rule system",
		"mcp-servers.md": "MCP configuration",
		"context-files.md": "AGENTS.md / CLAUDE.md hierarchy",
		"sessions.md": "Persistence, resume, compaction",
		"plan-mode.md": "Explore and plan before implementing",
		"reasoning.md": "Reasoning levels and provider support",
		"configuration.md": "Settings, env vars, .cast/ layout",
		"themes.md": "Color themes for the TUI",
		"non-interactive-mode.md": "cast run and JSON output",
		"architecture.md": "Source layout and design decisions",
		"changelog.md": "Version history and feature highlights",
	};
	return descs[file] || "";
}

function mdToHtml(md) {
	return marked.parse(md);
}

// ── Build ───────────────────────────────────────────────────────────────────
mkdirSync(SITE, { recursive: true });

// Copy install scripts for backward compatibility
cpSync(join(ROOT, "install.sh"), join(SITE, "install"));
cpSync(join(ROOT, "install.ps1"), join(SITE, "install.ps1"));
writeFileSync(join(SITE, ".nojekyll"), "");

// Landing page
writeFileSync(join(SITE, "index.html"), LANDING_HTML);
console.log("  index.html");

// Doc pages
for (const item of NAV_ORDER) {
	const md = readFileSync(join(DOCS, item.file), "utf-8");
	const bodyHtml = mdToHtml(md);
	const html = docPage(item.label, bodyHtml, item.file);
	const outFile = item.file.replace(".md", ".html");
	writeFileSync(join(SITE, outFile), html);
	console.log(`  ${outFile}`);
}

console.log(`\nSite built: ${SITE} (${NAV_ORDER.length + 1} pages)`);
