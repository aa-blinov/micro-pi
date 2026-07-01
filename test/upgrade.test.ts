import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLatestVersion, isAlreadyUpToDate, isNewerVersion } from "../src/core/upgrade.ts";

describe("isNewerVersion", () => {
	it("detects a newer patch version", () => {
		expect(isNewerVersion("0.1.0", "0.1.1")).toBe(true);
	});

	it("detects a newer minor version", () => {
		expect(isNewerVersion("0.1.9", "0.2.0")).toBe(true);
	});

	it("detects a newer major version", () => {
		expect(isNewerVersion("1.9.9", "2.0.0")).toBe(true);
	});

	it("returns false for the same version", () => {
		expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
	});

	it("returns false for an older candidate", () => {
		expect(isNewerVersion("0.2.0", "0.1.9")).toBe(false);
	});

	it("handles a leading 'v' on either side", () => {
		expect(isNewerVersion("v0.1.0", "v0.2.0")).toBe(true);
		expect(isNewerVersion("0.1.0", "v0.1.0")).toBe(false);
	});

	it("handles differing segment counts (missing patch treated as 0)", () => {
		expect(isNewerVersion("0.1", "0.1.1")).toBe(true);
		expect(isNewerVersion("0.1.0", "0.1")).toBe(false);
	});
});

describe("fetchLatestVersion", () => {
	const realFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("strips the 'v' prefix from the tag name", async () => {
		globalThis.fetch = vi.fn(
			async () => new Response(JSON.stringify({ tag_name: "v1.2.3" }), { status: 200 }),
		) as any;
		expect(await fetchLatestVersion()).toBe("1.2.3");
	});

	it("returns null on a non-ok response instead of throwing", async () => {
		globalThis.fetch = vi.fn(async () => new Response("", { status: 404 })) as any;
		expect(await fetchLatestVersion()).toBeNull();
	});

	it("returns null on a network error instead of throwing", async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error("network down");
		}) as any;
		expect(await fetchLatestVersion()).toBeNull();
	});

	it("returns null when the response has no tag_name", async () => {
		globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as any;
		expect(await fetchLatestVersion()).toBeNull();
	});
});

describe("isAlreadyUpToDate", () => {
	it("is true when current matches the target", () => {
		expect(isAlreadyUpToDate("0.2.0", "0.2.0", false)).toBe(true);
	});

	it("handles a leading 'v' on either side", () => {
		expect(isAlreadyUpToDate("0.2.0", "v0.2.0", false)).toBe(true);
		expect(isAlreadyUpToDate("v0.2.0", "0.2.0", false)).toBe(true);
	});

	it("is false when versions differ", () => {
		expect(isAlreadyUpToDate("0.1.0", "0.2.0", false)).toBe(false);
	});

	it("--force always reinstalls, even on a version match", () => {
		expect(isAlreadyUpToDate("0.2.0", "0.2.0", true)).toBe(false);
	});

	it("never skips when the target is unknown (fetchLatestVersion failed) — let the installer surface its own error", () => {
		expect(isAlreadyUpToDate("0.2.0", null, false)).toBe(false);
	});
});
