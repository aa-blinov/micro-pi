import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pickers } from "../src/pickers/types.ts";

// Stub the network probe and the settings writer; reconfigureConnection stays
// real (driven by fake pickers) so we test the recovery loop's actual wiring.
vi.mock("../src/core/config.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/config.ts")>();
	return { ...actual, probeProvider: vi.fn() };
});
vi.mock("../src/core/settings.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/settings.ts")>();
	return {
		...actual,
		// loadSettings stays real (driven by a fake $HOME so the test controls
		// the existing providers list); updateSettings is a spy so we can assert
		// exactly what was persisted.
		updateSettings: vi.fn(),
	};
});

const { ensureConnectionAlive } = await import("../src/core/startup.ts");
const { probeProvider } = await import("../src/core/config.ts");
const { updateSettings } = await import("../src/core/settings.ts");

const probe = vi.mocked(probeProvider);
const upd = vi.mocked(updateSettings);

let realHome: string | undefined;
let fakeHome: string;

function writeSettings(data: Record<string, unknown>): void {
	const dir = join(fakeHome, ".cast");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "settings.json"), JSON.stringify(data));
}

const config = () =>
	({ baseURL: "https://old.example/v1", apiKey: "sk-old" }) as Parameters<typeof ensureConnectionAlive>[0];

/** Fake pickers whose promptText hands back queued answers in call order. */
function promptPickers(answers: (string | null)[]): Pickers {
	let i = 0;
	return {
		pickOption: async () => null,
		promptText: async () => answers[i++] ?? null,
		log: () => {},
	} as unknown as Pickers;
}

beforeEach(() => {
	probe.mockReset();
	upd.mockReset();
	realHome = process.env.HOME;
	fakeHome = mkdtempSync(join(tmpdir(), "cast-ensure-test-"));
	process.env.HOME = fakeHome;
});

afterEach(() => {
	process.env.HOME = realHome;
	rmSync(fakeHome, { recursive: true, force: true });
});

describe("ensureConnectionAlive", () => {
	it("returns changed=false and never re-prompts when the connection is already ok", async () => {
		probe.mockResolvedValue("ok");
		expect(await ensureConnectionAlive(config(), promptPickers([]))).toBe(false);
		expect(upd).not.toHaveBeenCalled();
	});

	it("leaves an unclassifiable (unknown) provider alone — no nagging", async () => {
		probe.mockResolvedValue("unknown");
		expect(await ensureConnectionAlive(config(), promptPickers([]))).toBe(false);
		expect(upd).not.toHaveBeenCalled();
	});

	it("re-prompts on auth failure, applies + persists new creds, and reports changed=true", async () => {
		probe.mockResolvedValueOnce("auth").mockResolvedValueOnce("ok");
		const cfg = config();
		const changed = await ensureConnectionAlive(cfg, promptPickers(["https://new.example/v1", "sk-new"]));
		expect(changed).toBe(true);
		expect(cfg.baseURL).toBe("https://new.example/v1");
		expect(cfg.apiKey).toBe("sk-new");
		// Exact-match: the new providers seeding (added when the multi-provider
		// feature landed) must land in settings or /provider comes up empty
		// after reconnection.
		expect(upd).toHaveBeenCalledWith({
			providerUrl: "https://new.example/v1",
			apiKey: "sk-new",
			providers: [{ name: "default", url: "https://new.example/v1", apiKey: "sk-new" }],
		});
	});

	it("preserves existing providers when re-prompting reconnection", async () => {
		// Regression: a refactor that overwrites providers with a single-entry
		// default would silently drop the user's openrouter/whatever from the
		// /provider picker after the first reconnect.
		writeSettings({
			providers: [{ name: "openrouter", url: "https://openrouter.example/v1", apiKey: "sk-or" }],
		});
		probe.mockResolvedValueOnce("auth").mockResolvedValueOnce("ok");
		const cfg = config();
		const changed = await ensureConnectionAlive(cfg, promptPickers(["https://new.example/v1", "sk-new"]));
		expect(changed).toBe(true);
		expect(upd).toHaveBeenCalledWith({
			providerUrl: "https://new.example/v1",
			apiKey: "sk-new",
			providers: [
				{ name: "openrouter", url: "https://openrouter.example/v1", apiKey: "sk-or" },
				{ name: "default", url: "https://new.example/v1", apiKey: "sk-new" },
			],
		});
	});

	it("keeps looping while the connection stays bad, applying each new key", async () => {
		probe.mockResolvedValueOnce("auth").mockResolvedValueOnce("auth").mockResolvedValueOnce("ok");
		const cfg = config();
		const changed = await ensureConnectionAlive(
			cfg,
			promptPickers(["https://a.example/v1", "sk-1", "https://b.example/v1", "sk-2"]),
		);
		expect(changed).toBe(true);
		expect(cfg.apiKey).toBe("sk-2");
		expect(probe).toHaveBeenCalledTimes(3);
	});

	it("exits when the user cancels the credential prompt", async () => {
		probe.mockResolvedValue("auth");
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("exit(0)");
		});
		try {
			await expect(ensureConnectionAlive(config(), promptPickers([null]))).rejects.toThrow("exit(0)");
			expect(exitSpy).toHaveBeenCalledWith(0);
		} finally {
			exitSpy.mockRestore();
		}
	});
});
