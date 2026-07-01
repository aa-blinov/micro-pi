import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProjectTrust, loadSettings, type Settings } from "../src/core/settings.ts";
import { resolveProjectTrust } from "../src/pickers/domain.ts";
import type { Pickers } from "../src/pickers/types.ts";

/** Minimal fake Pickers — resolveProjectTrust only calls pickOption with a true/false choice. */
function fakePickers(answer: boolean | null): Pickers {
	return {
		pickOption: async () => answer,
		promptText: async () => null,
		log: () => {},
	} as unknown as Pickers;
}

describe("resolveProjectTrust", () => {
	let realHome: string | undefined;
	let fakeHome: string;
	let realIsTTY: boolean | undefined;

	beforeEach(() => {
		realHome = process.env.HOME;
		fakeHome = mkdtempSync(join(tmpdir(), "cast-select-test-"));
		process.env.HOME = fakeHome;
		realIsTTY = process.stdin.isTTY;
	});

	afterEach(() => {
		process.env.HOME = realHome;
		process.stdin.isTTY = realIsTTY as boolean;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	it("returns the cached decision without prompting when already asked", async () => {
		const settings: Settings = { projectTrust: { "/some/project": true } };
		const pickers = fakePickers(false); // would answer "no" if asked — must not be reached
		const trusted = await resolveProjectTrust(pickers, settings, "/some/project", ["  - .cast/skills/"]);
		expect(trusted).toBe(true);
	});

	it("defaults to not trusting when stdin isn't a TTY and nothing is cached", async () => {
		process.stdin.isTTY = false;
		const pickers = fakePickers(true); // would answer "yes" if asked — must not be reached
		const trusted = await resolveProjectTrust(pickers, {}, "/some/project", ["  - .cast/skills/"]);
		expect(trusted).toBe(false);
	});

	it("prompts and persists 'yes' as trusted", async () => {
		process.stdin.isTTY = true;
		const pickers = fakePickers(true);
		const trusted = await resolveProjectTrust(pickers, {}, join(fakeHome, "project"), ["  - .cast/skills/"]);
		expect(trusted).toBe(true);
		expect(getProjectTrust(loadSettings(), join(fakeHome, "project"))).toBe(true);
	});

	it("prompts and persists a 'no' (or cancel) as not trusted", async () => {
		process.stdin.isTTY = true;
		const pickers = fakePickers(null);
		const trusted = await resolveProjectTrust(pickers, {}, join(fakeHome, "project"), ["  - .cast/skills/"]);
		expect(trusted).toBe(false);
		expect(getProjectTrust(loadSettings(), join(fakeHome, "project"))).toBe(false);
	});
});
