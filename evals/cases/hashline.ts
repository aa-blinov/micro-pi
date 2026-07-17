/**
 * Hashline-focused eval cases — real-model runs of the exact patterns that
 * broke in the wild: inserting a section ABOVE a heading, multi-edit
 * chaining without re-reads, range replaces, deletions, and edits among
 * duplicate lines. Every check is grounded in the file bytes on disk.
 */

import { readFileSync } from "node:fs";
import { fixturePath, writeFixture } from "../fixtures.ts";
import type { EvalCase } from "../runner.ts";

const CHANGELOG = `# Changelog

All notable changes, newest first.

## 0.6.7

### Changed

- old entry one
- old entry two

## 0.6.5

### Fixed

- ancient fix
`;

const DUPES = `function a() {
	return 1;
}

function b() {
	return 1;
}

function c() {
	return 1;
}
`;

export const hashlineCases: EvalCase[] = [
	{
		id: "hashline-insert-above-heading",
		description: "Agent inserts a new changelog section ABOVE an existing heading (the real-world failure case)",
		setup: () => void writeFixture("hashline-insert-above-heading", { "changelog.md": CHANGELOG }),
		prompt:
			`In ${fixturePath("hashline-insert-above-heading", "changelog.md")}, add a new section for version 0.6.8 ` +
			`with one "### Fixed" bullet "- parser fix". It must go above the "## 0.6.7" section (newest first) ` +
			`and below the intro line, with proper blank-line separation. Do not touch anything else.`,
		timeout: 240_000,
		expect: {
			toolsCalled: ["read", "edit"],
			noErrors: true,
			verify: () => {
				const content = readFileSync(fixturePath("hashline-insert-above-heading", "changelog.md"), "utf-8");
				const i068 = content.indexOf("## 0.6.8");
				const i067 = content.indexOf("## 0.6.7");
				if (i068 === -1) return "no ## 0.6.8 section was added";
				if (i068 > i067) return "## 0.6.8 ended up below ## 0.6.7";
				if (!content.includes("parser fix")) return "bullet text missing";
				if (/##[^\n]*\n##/.test(content)) return "two headings glued without a blank line";
				if (!content.includes("- old entry one\n- old entry two")) return "existing 0.6.7 entries were damaged";
				if (!content.includes("## 0.6.5")) return "0.6.5 section was damaged";
				return undefined;
			},
		},
	},

	{
		id: "hashline-multi-edit-no-reread",
		description: "Agent performs three separate edits chaining anchors without excessive re-reads",
		setup: () =>
			void writeFixture("hashline-multi-edit-no-reread", {
				"config.ts": `export const config = {
	host: "localhost",
	port: 8080,
	debug: false,
	retries: 3,
	timeout: 5000,
};
`,
			}),
		prompt:
			`In ${fixturePath("hashline-multi-edit-no-reread", "config.ts")}: change port to 9090, ` +
			`set debug to true, and change timeout to 10000. Three small edits.`,
		timeout: 240_000,
		expect: {
			toolsCalled: ["read", "edit"],
			noErrors: true,
			verify: ({ toolCalls }) => {
				const content = readFileSync(fixturePath("hashline-multi-edit-no-reread", "config.ts"), "utf-8");
				if (!content.includes("port: 9090,")) return "port not changed";
				if (!content.includes("debug: true,")) return "debug not changed";
				if (!content.includes("timeout: 10000,")) return "timeout not changed";
				if (!content.includes('host: "localhost",') || !content.includes("retries: 3,"))
					return "untouched keys were damaged";
				const reads = toolCalls.filter((tc) => tc.name === "read").length;
				if (reads > 2)
					return `agent re-read the file ${reads} times — anchors/snippets should make that unnecessary`;
				return undefined;
			},
		},
	},

	{
		id: "hashline-range-replace-and-delete",
		description: "Agent replaces a multi-line range and deletes a line in the same file",
		setup: () =>
			void writeFixture("hashline-range-replace-and-delete", {
				"app.py": `import os
import sys
import json
import re

# TODO: remove this debug print
print("debug")

def main():
    return 0
`,
			}),
		prompt:
			`In ${fixturePath("hashline-range-replace-and-delete", "app.py")}: replace the four import lines ` +
			`with a single line "import json", and delete the TODO comment line and the debug print line entirely ` +
			`(no blank lines left behind where they were).`,
		timeout: 240_000,
		expect: {
			toolsCalled: ["read", "edit"],
			noErrors: true,
			verify: () => {
				const content = readFileSync(fixturePath("hashline-range-replace-and-delete", "app.py"), "utf-8");
				if (content.includes("import os") || content.includes("import sys") || content.includes("import re"))
					return "old imports still present";
				if (!content.includes("import json")) return "import json missing";
				if (content.includes("TODO") || content.includes('print("debug")')) return "debug lines not deleted";
				if (!content.includes("def main():\n    return 0")) return "main() was damaged";
				if (content.includes("\n\n\n")) return "left a double blank line behind";
				return undefined;
			},
		},
	},

	{
		id: "hashline-edit-among-duplicates",
		description: "Agent edits the middle of three identical function bodies",
		setup: () => void writeFixture("hashline-edit-among-duplicates", { "dupes.ts": DUPES }),
		prompt:
			`In ${fixturePath("hashline-edit-among-duplicates", "dupes.ts")}, change function b so it returns 2 ` +
			`instead of 1. Functions a and c must stay exactly as they are.`,
		timeout: 240_000,
		expect: {
			toolsCalled: ["read", "edit"],
			noErrors: true,
			verify: () => {
				const content = readFileSync(fixturePath("hashline-edit-among-duplicates", "dupes.ts"), "utf-8");
				const expected = DUPES.replace("function b() {\n\treturn 1;", "function b() {\n\treturn 2;");
				if (content !== expected) {
					const got = content.split("\n");
					const want = expected.split("\n");
					for (let i = 0; i < Math.max(got.length, want.length); i++) {
						if (got[i] !== want[i]) {
							return `line ${i + 1} differs: got ${JSON.stringify(got[i])}, want ${JSON.stringify(want[i])}`;
						}
					}
					return "content differs in length only";
				}
				return undefined;
			},
		},
	},

	{
		id: "hashline-move-block",
		description: "Agent moves a whole function above another (delete range + insert elsewhere)",
		setup: () =>
			void writeFixture("hashline-move-block", {
				"svc.ts": `export function run() {
	start();
	loop();
}

export function init() {
	setup();
	connect();
}
`,
			}),
		prompt:
			`In ${fixturePath("hashline-move-block", "svc.ts")}, move the entire init() function (all 4 lines) ` +
			`above run(), keeping one blank line between the two functions. The bodies must stay byte-identical.`,
		timeout: 240_000,
		expect: {
			toolsCalled: ["read", "edit"],
			noErrors: true,
			verify: () => {
				const content = readFileSync(fixturePath("hashline-move-block", "svc.ts"), "utf-8");
				const expected = `export function init() {
	setup();
	connect();
}

export function run() {
	start();
	loop();
}
`;
				if (content !== expected) {
					return `content differs — got:\n${JSON.stringify(content)}`;
				}
				return undefined;
			},
		},
	},

	{
		id: "hashline-large-file-needle",
		description: "Agent fixes one line deep in a 1500-line file without damaging neighbours",
		setup: () => {
			const lines = Array.from({ length: 1500 }, (_, i) => `export const item_${i + 1} = ${i + 1};`);
			lines[1041] = "export const item_1042 = -1; // BUG: wrong value";
			writeFixture("hashline-large-file-needle", { "items.ts": lines.join("\n") });
		},
		prompt:
			`${fixturePath("hashline-large-file-needle", "items.ts")} has exactly one line marked with "// BUG". ` +
			`Find it and fix the value so it matches the item number, removing the comment. Touch nothing else.`,
		timeout: 240_000,
		expect: {
			toolsCalled: ["edit"],
			noErrors: true,
			verify: () => {
				const content = readFileSync(fixturePath("hashline-large-file-needle", "items.ts"), "utf-8").split("\n");
				if (content.length !== 1500) return `file has ${content.length} lines, expected 1500`;
				if (content[1041] !== "export const item_1042 = 1042;")
					return `line 1042 is ${JSON.stringify(content[1041])}`;
				if (content[1040] !== "export const item_1041 = 1041;" || content[1042] !== "export const item_1043 = 1043;")
					return "neighbouring lines were damaged";
				return undefined;
			},
		},
	},

	{
		id: "hashline-second-duplicate-block",
		description: "Agent edits inside the SECOND of two byte-identical blocks",
		setup: () =>
			void writeFixture("hashline-second-duplicate-block", {
				"handlers.py": `def handle_get(req):
    validate(req)
    log(req)
    return respond(req)

def handle_post(req):
    validate(req)
    log(req)
    return respond(req)
`,
			}),
		prompt:
			`In ${fixturePath("hashline-second-duplicate-block", "handlers.py")}, inside handle_post only, ` +
			`replace the "log(req)" line with "audit(req)". handle_get must remain untouched.`,
		timeout: 240_000,
		expect: {
			toolsCalled: ["read", "edit"],
			noErrors: true,
			verify: () => {
				const content = readFileSync(fixturePath("hashline-second-duplicate-block", "handlers.py"), "utf-8");
				const getPart = content.slice(0, content.indexOf("def handle_post"));
				const postPart = content.slice(content.indexOf("def handle_post"));
				if (!getPart.includes("log(req)")) return "handle_get was modified";
				if (getPart.includes("audit")) return "audit leaked into handle_get";
				if (!postPart.includes("audit(req)")) return "handle_post not changed";
				if (postPart.includes("log(req)")) return "old log(req) still in handle_post";
				return undefined;
			},
		},
	},

	{
		id: "hashline-makefile-tabs",
		description: "Agent adds a Makefile target where recipe lines require hard tabs",
		setup: () =>
			void writeFixture("hashline-makefile-tabs", {
				Makefile: `.PHONY: build test

build:
\tnpm run build

test:
\tnpm test
`,
			}),
		prompt:
			`In ${fixturePath("hashline-makefile-tabs", "Makefile")}, add a "lint:" target after the test target ` +
			`that runs "npm run lint", and add lint to the .PHONY line. Makefile recipes must be tab-indented.`,
		timeout: 240_000,
		expect: {
			toolsCalled: ["read", "edit"],
			noErrors: true,
			verify: () => {
				const content = readFileSync(fixturePath("hashline-makefile-tabs", "Makefile"), "utf-8");
				if (!content.includes(".PHONY: build test lint") && !/\.PHONY:.*\blint\b/.test(content))
					return ".PHONY not updated";
				if (!content.includes("lint:\n\tnpm run lint")) return "lint target missing or recipe not tab-indented";
				if (!content.includes("build:\n\tnpm run build") || !content.includes("test:\n\tnpm test"))
					return "existing targets damaged";
				if (content.includes("    npm run lint")) return "recipe indented with spaces instead of a tab";
				return undefined;
			},
		},
	},

	{
		id: "hashline-json-nested",
		description: "Agent changes a nested JSON value and adds a sibling key, keeping the file valid JSON",
		setup: () =>
			void writeFixture("hashline-json-nested", {
				"config.json": `{
	"name": "svc",
	"server": {
		"host": "0.0.0.0",
		"port": 3000,
		"tls": {
			"enabled": false,
			"cert": ""
		}
	},
	"logging": {
		"level": "info"
	}
}
`,
			}),
		prompt:
			`In ${fixturePath("hashline-json-nested", "config.json")}: enable tls (set enabled to true), ` +
			`set cert to "/etc/ssl/svc.pem", and add "keepAliveMs": 30000 inside "server" (sibling of port). ` +
			`The file must stay valid JSON.`,
		timeout: 240_000,
		expect: {
			toolsCalled: ["read", "edit"],
			noErrors: true,
			verify: () => {
				const raw = readFileSync(fixturePath("hashline-json-nested", "config.json"), "utf-8");
				let parsed: {
					server?: { port?: number; keepAliveMs?: number; tls?: { enabled?: boolean; cert?: string } };
					logging?: { level?: string };
				};
				try {
					parsed = JSON.parse(raw);
				} catch (e) {
					return `file is no longer valid JSON: ${e}`;
				}
				if (parsed.server?.tls?.enabled !== true) return "tls.enabled not true";
				if (parsed.server?.tls?.cert !== "/etc/ssl/svc.pem") return "cert not set";
				if (parsed.server?.keepAliveMs !== 30000) return "keepAliveMs missing";
				if (parsed.server?.port !== 3000 || parsed.logging?.level !== "info") return "untouched keys damaged";
				return undefined;
			},
		},
	},

	{
		id: "hashline-dependent-edits",
		description: "Agent makes a second edit inside the region its first edit just rewrote (anchor chaining)",
		setup: () =>
			void writeFixture("hashline-dependent-edits", {
				"job.py": `def process(items):
    for item in items:
        transform(item)
        save(item)
    return len(items)
`,
			}),
		prompt:
			`In ${fixturePath("hashline-dependent-edits", "job.py")}, two changes that build on each other: ` +
			`first wrap the two loop-body lines (transform/save) in a "try:" block with an "except Exception:" ` +
			`handler that calls "log_error(item)"; then, as a second step, add a "retry(item)" call inside the ` +
			`except handler right after log_error(item). Keep 4-space indentation consistent.`,
		timeout: 240_000,
		expect: {
			toolsCalled: ["read", "edit"],
			noErrors: true,
			verify: () => {
				const content = readFileSync(fixturePath("hashline-dependent-edits", "job.py"), "utf-8");
				if (!content.includes("try:")) return "no try block";
				if (!/except Exception:/.test(content)) return "no except handler";
				const logIdx = content.indexOf("log_error(item)");
				const retryIdx = content.indexOf("retry(item)");
				if (logIdx === -1) return "log_error call missing";
				if (retryIdx === -1) return "retry call missing";
				if (retryIdx < logIdx) return "retry(item) is not after log_error(item)";
				if (!content.includes("transform(item)") || !content.includes("save(item)")) return "loop body lost";
				if (!content.includes("return len(items)")) return "return statement lost";
				// The whole thing must still be plausible Python: no mixed tabs.
				if (content.includes("\t")) return "tabs leaked into a 4-space-indented file";
				return undefined;
			},
		},
	},
];
