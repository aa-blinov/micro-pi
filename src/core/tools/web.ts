/**
 * Web tools — DDG search (html.duckduckgo.com scraper) + Jina Reader (fetch).
 *
 * DDG search scrapes the HTML lite endpoint — no JS challenge, no VQD,
 * no Python dependency. Returns title + URL + snippet per result.
 * DDG rate-limits after ~4 requests per IP — cached results don't count
 * toward the limit, so repeated queries are free.
 *
 * Web fetch uses Jina Reader (`r.jina.ai`) — free, no API key, returns
 * clean markdown optimized for LLM consumption.
 */

import type { ToolResult } from "./shared.ts";

// ============================================================================
// Constants
// ============================================================================

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 30_000;
const MAX_CONTENT_CHARS = 12_000;
const MAX_SEARCH_RESULTS = 10;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX_ENTRIES = 100;

// ============================================================================
// DDG Search — html.duckduckgo.com
// ============================================================================

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

interface SearchResults {
	query: string;
	results: SearchResult[];
}

/** In-memory search cache — avoids wasting DDG's ~4 request budget on repeats. */
const searchCache = new Map<string, { results: SearchResults; ts: number }>();

function cacheKey(query: string, region?: string, time?: string): string {
	return `${query}\0${region ?? ""}\0${time ?? ""}`;
}

function cacheGet(key: string): SearchResults | null {
	const entry = searchCache.get(key);
	if (!entry) return null;
	if (Date.now() - entry.ts > CACHE_TTL_MS) {
		searchCache.delete(key);
		return null;
	}
	return entry.results;
}

function cacheSet(key: string, results: SearchResults): void {
	if (searchCache.size >= CACHE_MAX_ENTRIES) {
		// Evict oldest entry
		const first = searchCache.keys().next().value;
		if (first !== undefined) searchCache.delete(first);
	}
	searchCache.set(key, { results, ts: Date.now() });
}

/** Decode DDG redirect URL: `//duckduckgo.com/l/?uddg=https%3A%2F%2F...` → `https://...` */
function decodeDdgUrl(href: string): string {
	try {
		const uddg = /uddg=([^&"]+)/.exec(href);
		if (uddg) return decodeURIComponent(uddg[1]);
		if (href.startsWith("http")) return href;
		return "";
	} catch {
		return "";
	}
}

/** Strip HTML tags and decode common entities. */
function stripTags(html: string): string {
	return html
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#\d+;/g, (m) => {
			const code = Number.parseInt(m.slice(2, -1), 10);
			return Number.isNaN(code) ? m : String.fromCodePoint(code);
		})
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Search DuckDuckGo via the HTML lite endpoint.
 * No API key, no JS challenge, no Python. Pure fetch + regex.
 *
 * DDG rate-limits to ~4 requests per IP. Cached results are returned
 * instantly without hitting DDG. When rate-limited, returns a clear error
 * instead of empty results.
 */
export async function searchDuckDuckGo(
	query: string,
	options?: {
		maxResults?: number;
		region?: string;
		time?: string;
		signal?: AbortSignal;
	},
): Promise<SearchResults> {
	const maxResults = options?.maxResults ?? MAX_SEARCH_RESULTS;
	const signal = options?.signal;

	// Check cache first
	const key = cacheKey(query, options?.region, options?.time);
	const cached = cacheGet(key);
	if (cached) return { ...cached, results: cached.results.slice(0, maxResults) };

	const params = new URLSearchParams({ q: query });
	if (options?.region) params.set("kl", options.region);
	if (options?.time) params.set("df", options.time);
	const url = `https://html.duckduckgo.com/html/?${params.toString()}`;
	const resp = await fetch(url, {
		headers: {
			"User-Agent": UA,
			Accept: "text/html",
			"Accept-Language": "en-US,en;q=0.9",
		},
		signal,
	});

	if (resp.status === 202) {
		throw new Error(
			"DDG rate limit — CAPTCHA triggered. Too many searches from this IP. " +
				"Try again later or use a different search provider.",
		);
	}
	if (!resp.ok) throw new Error(`DDG HTTP ${resp.status}`);

	const html = await resp.text();

	// Detect CAPTCHA page (sometimes returned as 200)
	if (html.includes("Please complete the following challenge")) {
		throw new Error("DDG rate limit — CAPTCHA triggered. Try again later.");
	}

	// Parse results
	const blocks = html.split(/<div[^>]+class="result\s/);
	const results: SearchResult[] = [];

	for (let i = 1; i < blocks.length && results.length < maxResults; i++) {
		const block = blocks[i];

		const titleMatch = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
		if (!titleMatch) continue;

		const resultUrl = decodeDdgUrl(titleMatch[1]);
		if (!resultUrl) continue;
		const title = stripTags(titleMatch[2]);
		if (!title) continue;

		const snippetMatch = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
		const snippet = snippetMatch ? stripTags(snippetMatch[1]) : "";

		results.push({ title, url: resultUrl, snippet });
	}

	const searchResults = { query, results };

	// Cache even empty results to avoid re-hitting DDG
	cacheSet(key, searchResults);

	return searchResults;
}

// ============================================================================
// Web Fetch — Jina Reader API
// ============================================================================

/**
 * Fetch a URL via Jina Reader (`r.jina.ai`).
 * Returns clean markdown content optimized for LLM consumption.
 */
export async function fetchUrl(
	url: string,
	options?: { maxChars?: number; signal?: AbortSignal },
): Promise<{ url: string; title: string; content: string }> {
	const maxChars = options?.maxChars ?? MAX_CONTENT_CHARS;
	const signal = options?.signal;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	const onAbort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const resp = await fetch(`https://r.jina.ai/${url}`, {
			headers: {
				Accept: "text/markdown",
				"X-Return-Format": "markdown",
			},
			redirect: "follow",
			signal: controller.signal,
		});

		if (!resp.ok) throw new Error(`Jina Reader HTTP ${resp.status} ${resp.statusText}`);

		const text = await resp.text();

		// Jina Reader's response is a metadata block followed by the actual
		// content, not a bare markdown document:
		//   Title: ...\n\nURL Source: ...\n\n[Warning: ...\n\n]Markdown Content:\n\n<content>
		let title = "";
		const titleMatch = /^Title: (.+)$/m.exec(text);
		if (titleMatch) title = titleMatch[1].trim();

		let content = text;
		const marker = "Markdown Content:";
		const markerIdx = text.indexOf(marker);
		if (markerIdx !== -1) content = text.slice(markerIdx + marker.length);

		return {
			url,
			title,
			content: content.trim().slice(0, maxChars),
		};
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
	}
}

// ============================================================================
// Tool executors
// ============================================================================

export async function execWebSearch(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
	const query = String(args.query ?? "").trim();
	if (!query) return { content: "Error: 'query' is required.", isError: true };

	const maxResults = typeof args.maxResults === "number" ? args.maxResults : MAX_SEARCH_RESULTS;
	const region = typeof args.region === "string" ? args.region : undefined;
	const time = typeof args.time === "string" ? args.time : undefined;

	try {
		const { results } = await searchDuckDuckGo(query, { maxResults, region, time, signal });

		if (results.length === 0) return { content: `No results found for "${query}".` };

		const lines = results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`);
		return { content: `<!--${JSON.stringify({ count: results.length })}-->\n${lines.join("\n\n")}` };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return { content: `Search error: ${msg}`, isError: true };
	}
}

export async function execWebFetch(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
	const url = String(args.url ?? "").trim();
	if (!url) return { content: "Error: 'url' is required.", isError: true };

	try {
		new URL(url);
	} catch {
		return { content: `Error: invalid URL "${url}".`, isError: true };
	}

	const maxChars = typeof args.maxChars === "number" ? args.maxChars : MAX_CONTENT_CHARS;

	try {
		const result = await fetchUrl(url, { maxChars, signal });

		const parts: string[] = [];
		if (result.title) parts.push(`# ${result.title}`);
		parts.push(result.content || "[Empty page]");

		return { content: parts.join("\n\n") };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return { content: `Fetch error: ${msg}`, isError: true };
	}
}
