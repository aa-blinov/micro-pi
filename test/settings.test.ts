import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProjectTrust, loadSettings, setProjectTrust } from "../src/core/settings.ts";

describe("settings", () => {
	let realHome: string | undefined;
	let fakeHome: string;

	beforeEach(() => {
		realHome = process.env.HOME;
		fakeHome = mkdtempSync(join(tmpdir(), "cast-settings-test-"));
		process.env.HOME = fakeHome;
	});

	afterEach(() => {
		process.env.HOME = realHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	describe("project trust", () => {
		it("is undefined (never asked) for a project with no recorded decision", () => {
			expect(getProjectTrust(loadSettings(), "/some/project")).toBeUndefined();
		});

		it("persists a trust decision across loadSettings() calls", () => {
			setProjectTrust("/some/project", true);
			expect(getProjectTrust(loadSettings(), "/some/project")).toBe(true);
		});

		it("keeps decisions for different projects independent", () => {
			setProjectTrust("/project/a", true);
			setProjectTrust("/project/b", false);
			const settings = loadSettings();
			expect(getProjectTrust(settings, "/project/a")).toBe(true);
			expect(getProjectTrust(settings, "/project/b")).toBe(false);
		});

		it("overwrites a prior decision for the same project", () => {
			setProjectTrust("/some/project", true);
			setProjectTrust("/some/project", false);
			expect(getProjectTrust(loadSettings(), "/some/project")).toBe(false);
		});
	});
});
