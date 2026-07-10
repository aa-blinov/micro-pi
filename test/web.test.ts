import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execWebFetch, execWebSearch, fetchUrl, searchDuckDuckGo } from "../src/core/tools/web.ts";

function ddgHtml(results: { title: string; href: string; snippet: string }[]): string {
	return results
		.map(
			(r) =>
				`<div class="result results_links results_links_deep web-result">` +
				`<a class="result__a" href="${r.href}">${r.title}</a>` +
				`<a class="result__snippet">${r.snippet}</a>` +
				`</div>`,
		)
		.join("\n");
}

function mockFetchOnce(response: { ok: boolean; status: number; statusText?: string; text: string }): void {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({
			ok: response.ok,
			status: response.status,
			statusText: response.statusText ?? "",
			text: async () => response.text,
		}),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

// ============================================================================
// web_search
// ============================================================================

describe("execWebSearch", () => {
	it("requires a query", async () => {
		const result = await execWebSearch({});
		expect(result.isError).toBe(true);
		expect(result.content).toContain("query");
	});
});

describe("searchDuckDuckGo", () => {
	it("parses titles, decoded URLs, and snippets from the DDG HTML endpoint", async () => {
		const html = ddgHtml([
			{
				title: "Example Title",
				href: "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage",
				snippet: "Example snippet text.",
			},
			{ title: "Another Title", href: "https://another.com/", snippet: "Another snippet." },
		]);
		mockFetchOnce({ ok: true, status: 200, text: html });

		const { results } = await searchDuckDuckGo("unique query one");

		expect(results).toEqual([
			{ title: "Example Title", url: "https://example.com/page", snippet: "Example snippet text." },
			{ title: "Another Title", url: "https://another.com/", snippet: "Another snippet." },
		]);
	});

	it("throws a clear error when DDG returns a rate-limit challenge (status 202)", async () => {
		mockFetchOnce({ ok: false, status: 202, text: "" });

		await expect(searchDuckDuckGo("unique query two")).rejects.toThrow(/rate limit/i);
	});

	it("caches results so a repeated query doesn't hit DDG again", async () => {
		const html = ddgHtml([{ title: "Cached", href: "https://cached.example/", snippet: "s" }]);
		mockFetchOnce({ ok: true, status: 200, text: html });

		await searchDuckDuckGo("unique query three");
		await searchDuckDuckGo("unique query three");

		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

// ============================================================================
// web_fetch
// ============================================================================

describe("execWebFetch", () => {
	it("requires a url", async () => {
		const result = await execWebFetch({});
		expect(result.isError).toBe(true);
		expect(result.content).toContain("url");
	});

	it("rejects an invalid url", async () => {
		const result = await execWebFetch({ url: "not-a-url" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("invalid URL");
	});
});

describe("fetchUrl", () => {
	it("extracts the title and strips the metadata preamble from Jina Reader's response", async () => {
		// Real r.jina.ai response shape: a metadata block ("Title:", "URL Source:",
		// optional "Warning:") followed by "Markdown Content:" and the actual body —
		// not a bare markdown document starting with a top-level heading.
		const jinaResponse =
			"Title: Example Domain\n\n" +
			"URL Source: https://example.com/\n\n" +
			"Published Time: Wed, 01 Jul 2026 17:50:18 GMT\n\n" +
			"Warning: This is a cached snapshot of the original page, consider retry with caching opt-out.\n\n" +
			"Markdown Content:\n" +
			"# Example Domain\n\n" +
			"This domain is for use in documentation examples without needing permission.\n";
		mockFetchOnce({ ok: true, status: 200, text: jinaResponse });

		const result = await fetchUrl("https://example.com/");

		expect(result.title).toBe("Example Domain");
		expect(result.content).toBe(
			"# Example Domain\n\nThis domain is for use in documentation examples without needing permission.",
		);
		expect(result.content).not.toContain("URL Source:");
		expect(result.content).not.toContain("Warning:");
	});

	it("removes its abort listener from an externally-supplied signal once the request settles", async () => {
		mockFetchOnce({ ok: true, status: 200, text: "Title: t\n\nMarkdown Content:\nbody" });
		const controller = new AbortController();

		await fetchUrl("https://example.com/", { signal: controller.signal });

		// The signal is long-lived and shared across every tool call in a session
		// (see loop.ts) — a listener left behind here would leak on every fetch.
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});
});
