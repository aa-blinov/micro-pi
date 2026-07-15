import { describe, expect, it } from "vitest";
import { selectMcpServers } from "../src/pickers/domain.ts";
import type { Pickers, PickOption, PickOptions } from "../src/pickers/types.ts";

/** Fake pickers that queue pickMulti results. */
function fakePickers(multiResult: string[] | null): Pickers {
	return {
		pickOption: async () => null,
		promptText: async () => null,
		pickMulti: async () => multiResult,
		log: () => {},
	};
}

describe("selectMcpServers", () => {
	const allNames = ["context7", "github", "local-tools"];
	const toolCounts: Record<string, number> = { context7: 5, "local-tools": 3 };

	it("returns null on cancel", async () => {
		const pickers = fakePickers(null);
		const result = await selectMcpServers(pickers, allNames, [], toolCounts);
		expect(result).toBeNull();
	});

	it("returns enabled names on confirm", async () => {
		const pickers = fakePickers(["context7", "local-tools"]);
		const result = await selectMcpServers(pickers, allNames, [], toolCounts);
		expect(result).toEqual(["context7", "local-tools"]);
	});

	it("passes correct initialSelected based on disabled list", async () => {
		let capturedOpts: (PickOptions & { initialSelected?: string[] }) | undefined;
		const pickers: Pickers = {
			pickOption: async () => null,
			promptText: async () => null,
			pickMulti: async (_opts, opts) => {
				capturedOpts = opts;
				return null;
			},
			log: () => {},
		};
		await selectMcpServers(pickers, allNames, ["github"], toolCounts);
		// github is disabled, so initialSelected should be context7 + local-tools
		expect(capturedOpts?.initialSelected).toEqual(["context7", "local-tools"]);
	});

	it("all enabled when disabled list is empty", async () => {
		let capturedOpts: (PickOptions & { initialSelected?: string[] }) | undefined;
		const pickers: Pickers = {
			pickOption: async () => null,
			promptText: async () => null,
			pickMulti: async (_opts, opts) => {
				capturedOpts = opts;
				return null;
			},
			log: () => {},
		};
		await selectMcpServers(pickers, allNames, [], toolCounts);
		expect(capturedOpts?.initialSelected).toEqual(allNames);
	});

	it("builds correct option labels with tool counts", async () => {
		let capturedOptions: PickOption<string>[] | undefined;
		const pickers: Pickers = {
			pickOption: async () => null,
			promptText: async () => null,
			pickMulti: async (options) => {
				capturedOptions = options;
				return null;
			},
			log: () => {},
		};
		await selectMcpServers(pickers, allNames, ["github"], toolCounts);
		expect(capturedOptions).toEqual([
			{ value: "context7", label: "context7 (5 tools)" },
			{ value: "github", label: "github (disabled)" },
			{ value: "local-tools", label: "local-tools (3 tools)" },
		]);
	});

	it("shows disconnected for servers not in toolCounts and not disabled", async () => {
		let capturedOptions: PickOption<string>[] | undefined;
		const pickers: Pickers = {
			pickOption: async () => null,
			promptText: async () => null,
			pickMulti: async (options) => {
				capturedOptions = options;
				return null;
			},
			log: () => {},
		};
		await selectMcpServers(pickers, allNames, [], toolCounts);
		// github has no toolCount and is not disabled → disconnected
		expect(capturedOptions![1]).toEqual({ value: "github", label: "github (disconnected)" });
	});

	it("handles global + project servers (merged by name, no duplicates)", async () => {
		// Simulates: global has context7 + db-admin, project has github + db-admin (override)
		// After merge: context7, github, db-admin (project version)
		const merged = ["context7", "github", "db-admin"];
		const counts: Record<string, number> = { context7: 5, "db-admin": 8 };
		// github failed to connect (no count), db-admin is from project (overrode global)
		let capturedOptions: PickOption<string>[] | undefined;
		let capturedInitial: string[] | undefined;
		const pickers: Pickers = {
			pickOption: async () => null,
			promptText: async () => null,
			pickMulti: async (options, opts) => {
				capturedOptions = options;
				capturedInitial = opts?.initialSelected;
				return null;
			},
			log: () => {},
		};
		// db-admin was previously disabled
		await selectMcpServers(pickers, merged, ["db-admin"], counts);
		expect(capturedOptions).toEqual([
			{ value: "context7", label: "context7 (5 tools)" },
			{ value: "github", label: "github (disconnected)" },
			{ value: "db-admin", label: "db-admin (disabled)" },
		]);
		// db-admin disabled → only context7 and github initially selected
		expect(capturedInitial).toEqual(["context7", "github"]);
	});

	it("disabling a previously-enabled server and re-enabling works", async () => {
		const all = ["a", "b", "c"];
		const counts: Record<string, number> = { a: 1, b: 2, c: 3 };
		// Step 1: all enabled, user disables b
		const pickers1 = fakePickers(["a", "c"]);
		const r1 = await selectMcpServers(pickers1, all, [], counts);
		expect(r1).toEqual(["a", "c"]);
		// Step 2: b is now disabled, user re-enables it
		const pickers2 = fakePickers(["a", "b", "c"]);
		const r2 = await selectMcpServers(pickers2, all, ["b"], counts);
		expect(r2).toEqual(["a", "b", "c"]);
	});
});
