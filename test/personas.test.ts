import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PERSONA, findPersona, listPersonas, loadPersonas } from "../src/core/personas.ts";
import { getToolDefinitions } from "../src/core/tools.ts";

const PERSONAS_DIR = join(import.meta.dirname, "..", "prompts", "personas");
const ERROR_HANDLING_FILE = join(import.meta.dirname, "..", "prompts", "error-handling.md");
const TOOLS_EDIT_FILE = join(import.meta.dirname, "..", "prompts", "tools-edit.md");

describe("listPersonas", () => {
	it("finds the shipped coding and fiction-writer personas", () => {
		const names = listPersonas().map((p) => p.name);
		expect(names).toContain("coding");
		expect(names).toContain("fiction-writer");
	});

	it("sorts the default persona first", () => {
		const personas = listPersonas();
		expect(personas[0]?.name).toBe(DEFAULT_PERSONA);
	});

	it("parses label and description from frontmatter", () => {
		const coding = listPersonas().find((p) => p.name === "coding")!;
		expect(coding.label).toBe("Coding agent");
		expect(coding.description.length).toBeGreaterThan(0);
	});

	it("strips frontmatter from the system prompt body", () => {
		for (const persona of listPersonas()) {
			// The body must not begin with a frontmatter block — that's the sign
			// the `---`-delimited header wasn't stripped. (A bare `---` further down
			// is fine: e.g. tech-writer teaches Mermaid config, which uses it.)
			expect(persona.systemPrompt.trimStart().startsWith("---")).toBe(false);
			expect(persona.systemPrompt.length).toBeGreaterThan(0);
		}
	});

	it("gives each persona a distinct system prompt", () => {
		const coding = findPersona("coding")!;
		const writer = findPersona("fiction-writer")!;
		expect(coding.systemPrompt).not.toBe(writer.systemPrompt);
		expect(writer.systemPrompt.toLowerCase()).toContain("fiction");
	});

	it("appends an identical Error Handling block to every persona, sourced from prompts/error-handling.md", () => {
		const personas = listPersonas();
		expect(personas.length).toBeGreaterThan(1);
		const expected = readFileSync(ERROR_HANDLING_FILE, "utf-8").trim();

		for (const persona of personas) {
			const idx = persona.systemPrompt.indexOf("## Error Handling");
			expect(idx).toBeGreaterThan(-1);
			// Slice up to (but not including) the next shared section, so
			// the test stays stable as more shared blocks get appended.
			const after = persona.systemPrompt.slice(idx);
			const editIdx = after.indexOf("## edit / hashline anchors");
			const section = editIdx === -1 ? after : after.slice(0, editIdx).trimEnd();
			expect(section).toBe(expected);
			expect(persona.systemPrompt).toContain("## edit / hashline anchors");
		}

		// It must come from prompts/error-handling.md, not be duplicated by hand
		// in the persona files themselves (that's exactly the drift this guards against).
		for (const persona of personas) {
			const raw = readFileSync(join(PERSONAS_DIR, `${persona.name}.md`), "utf-8");
			expect(raw).not.toContain("## Error Handling");
			expect(raw).not.toContain("## edit / hashline anchors");
		}

		// Same shared-source contract for the new tool-guidance block.
		const toolsExpected = readFileSync(TOOLS_EDIT_FILE, "utf-8").trim();
		for (const persona of personas) {
			expect(persona.systemPrompt).toContain(toolsExpected);
		}
	});
});

describe("findPersona", () => {
	it("returns undefined for an unknown name", () => {
		expect(findPersona("does-not-exist")).toBeUndefined();
	});

	it("finds a known persona by exact name", () => {
		expect(findPersona("fiction-writer")?.name).toBe("fiction-writer");
	});
});

// ============================================================================
// loadPersonas: multi-source (builtin + global + project)
// ============================================================================

const TEST_DIR = join(import.meta.dirname, "__test_tmp_personas__");
const GLOBAL_DIR = join(TEST_DIR, "global");
const PROJECT_DIR = join(TEST_DIR, "project");

function writePersona(dir: string, name: string, body: string, label?: string): void {
	mkdirSync(dir, { recursive: true });
	const fm = [`name: ${name}`, label ? `label: ${label}` : `label: ${name}`].join("\n");
	writeFileSync(join(dir, `${name}.md`), `---\n${fm}\n---\n\n${body}\n`, "utf-8");
}

beforeEach(() => {
	mkdirSync(GLOBAL_DIR, { recursive: true });
	mkdirSync(PROJECT_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("loadPersonas multi-source", () => {
	it("loads builtin personas when no global/project dirs given", () => {
		const personas = loadPersonas();
		expect(personas.length).toBeGreaterThan(0);
		for (const p of personas) expect(p.source).toBe("builtin");
	});

	it("loads global user personas", () => {
		writePersona(GLOBAL_DIR, "custom", "You are a custom assistant.", "Custom");
		const personas = loadPersonas({ globalDir: GLOBAL_DIR });
		const custom = personas.find((p) => p.name === "custom");
		expect(custom).toBeDefined();
		expect(custom!.source).toBe("global");
		expect(custom!.label).toBe("Custom");
	});

	it("loads project personas", () => {
		writePersona(PROJECT_DIR, "proj-only", "Project specific.", "Project");
		const personas = loadPersonas({ projectDir: PROJECT_DIR });
		const proj = personas.find((p) => p.name === "proj-only");
		expect(proj).toBeDefined();
		expect(proj!.source).toBe("project");
	});

	it("project persona wins over global on name collision", () => {
		writePersona(GLOBAL_DIR, "dup", "Global version.", "Global Dup");
		writePersona(PROJECT_DIR, "dup", "Project version.", "Project Dup");
		const personas = loadPersonas({ globalDir: GLOBAL_DIR, projectDir: PROJECT_DIR });
		const dups = personas.filter((p) => p.name === "dup");
		expect(dups).toHaveLength(1);
		expect(dups[0].source).toBe("project");
		expect(dups[0].label).toBe("Project Dup");
	});

	it("global persona wins over builtin on name collision", () => {
		writePersona(GLOBAL_DIR, "coding", "Overridden coding.", "My Coding");
		const personas = loadPersonas({ globalDir: GLOBAL_DIR });
		const codings = personas.filter((p) => p.name === "coding");
		expect(codings).toHaveLength(1);
		expect(codings[0].source).toBe("global");
		expect(codings[0].label).toBe("My Coding");
	});

	it("findPersona respects multi-source options", () => {
		writePersona(GLOBAL_DIR, "special", "Special assistant.", "Special");
		const found = findPersona("special", { globalDir: GLOBAL_DIR });
		expect(found).toBeDefined();
		expect(found!.source).toBe("global");
	});

	it("each persona gets error-handling appended", () => {
		writePersona(GLOBAL_DIR, "test-pers", "Test body.");
		const personas = loadPersonas({ globalDir: GLOBAL_DIR });
		const testPers = personas.find((p) => p.name === "test-pers")!;
		expect(testPers.systemPrompt).toContain("## Error Handling");
	});
});

describe("subagents field", () => {
	it("defaults to false when not specified in frontmatter", () => {
		writePersona(GLOBAL_DIR, "no-field", "No subagents field.");
		const personas = loadPersonas({ globalDir: GLOBAL_DIR });
		const p = personas.find((p) => p.name === "no-field")!;
		expect(p.subagents).toBe(false);
	});

	it("parses subagents: true from frontmatter", () => {
		mkdirSync(GLOBAL_DIR, { recursive: true });
		writeFileSync(
			join(GLOBAL_DIR, "with-sub.md"),
			`---\nname: with-sub\nlabel: With Sub\nsubagents: true\n---\n\nBody.\n`,
			"utf-8",
		);
		const personas = loadPersonas({ globalDir: GLOBAL_DIR });
		const p = personas.find((p) => p.name === "with-sub")!;
		expect(p.subagents).toBe(true);
	});

	it("parses subagents: false from frontmatter", () => {
		mkdirSync(GLOBAL_DIR, { recursive: true });
		writeFileSync(
			join(GLOBAL_DIR, "no-sub.md"),
			`---\nname: no-sub\nlabel: No Sub\nsubagents: false\n---\n\nBody.\n`,
			"utf-8",
		);
		const personas = loadPersonas({ globalDir: GLOBAL_DIR });
		const p = personas.find((p) => p.name === "no-sub")!;
		expect(p.subagents).toBe(false);
	});

	it("only coder-with-subagents has subagents: true among builtins", () => {
		const personas = loadPersonas();
		const withSub = personas.filter((p) => p.subagents);
		expect(withSub.map((p) => p.name).sort()).toEqual(["coder-with-subagents"]);
	});
});

describe("getToolDefinitions + subagents", () => {
	it("includes task tool when personaNames is provided", () => {
		const tools = getToolDefinitions(["qa", "writer"]);
		const taskTool = tools.find((t) => t.function.name === "task");
		expect(taskTool).toBeDefined();
	});

	it("excludes task tool when personaNames is undefined", () => {
		const tools = getToolDefinitions(undefined);
		const taskTool = tools.find((t) => t.function.name === "task");
		expect(taskTool).toBeUndefined();
	});

	it("excludes task tool when personaNames is empty array", () => {
		const tools = getToolDefinitions([]);
		const taskTool = tools.find((t) => t.function.name === "task");
		expect(taskTool).toBeUndefined();
	});

	it("task description lists only the provided subagent names", () => {
		const tools = getToolDefinitions(["qa", "writer"]);
		const taskTool = tools.find((t) => t.function.name === "task")!;
		expect(taskTool.function.description).toContain("qa, writer");
	});

	it("task tool exposes a `subagent` parameter, not `persona`", () => {
		const tools = getToolDefinitions(["worker"]);
		const taskTool = tools.find((t) => t.function.name === "task")!;
		const props = (taskTool.function.parameters as { properties: Record<string, unknown> }).properties;
		expect(props).toHaveProperty("subagent");
		expect(props).not.toHaveProperty("persona");
	});

	it("task description advertises 'worker' as the default when present", () => {
		const tools = getToolDefinitions(["analyst", "worker"]);
		const taskTool = tools.find((t) => t.function.name === "task")!;
		expect(taskTool.function.description).toContain('Defaults to "worker"');
	});
});

describe("subagents integration with getToolDefinitions", () => {
	it("coding persona (subagents: false) produces no task tool", () => {
		const persona = findPersona("coding")!;
		const subagentNames = persona.subagents ? ["worker"] : undefined;
		const tools = getToolDefinitions(subagentNames);
		expect(tools.some((t) => t.function.name === "task")).toBe(false);
	});

	it("coder-with-subagents persona (subagents: true) produces task tool", () => {
		const persona = findPersona("coder-with-subagents")!;
		const subagentNames = persona.subagents ? ["worker"] : undefined;
		const tools = getToolDefinitions(subagentNames);
		expect(tools.some((t) => t.function.name === "task")).toBe(true);
	});
});
