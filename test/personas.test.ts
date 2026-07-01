import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PERSONA, findPersona, listPersonas } from "../src/core/personas.ts";

const PERSONAS_DIR = join(import.meta.dirname, "..", "prompts", "personas");
const ERROR_HANDLING_FILE = join(import.meta.dirname, "..", "prompts", "error-handling.md");

describe("listPersonas", () => {
	it("finds the shipped coding and writer personas", () => {
		const names = listPersonas().map((p) => p.name);
		expect(names).toContain("coding");
		expect(names).toContain("writer");
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
			expect(persona.systemPrompt).not.toContain("---");
			expect(persona.systemPrompt.length).toBeGreaterThan(0);
		}
	});

	it("gives each persona a distinct system prompt", () => {
		const coding = findPersona("coding")!;
		const writer = findPersona("writer")!;
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
			expect(persona.systemPrompt.slice(idx)).toBe(expected);
		}

		// It must come from prompts/error-handling.md, not be duplicated by hand
		// in the persona files themselves (that's exactly the drift this guards against).
		for (const persona of personas) {
			const raw = readFileSync(join(PERSONAS_DIR, `${persona.name}.md`), "utf-8");
			expect(raw).not.toContain("## Error Handling");
		}
	});
});

describe("findPersona", () => {
	it("returns undefined for an unknown name", () => {
		expect(findPersona("does-not-exist")).toBeUndefined();
	});

	it("finds a known persona by exact name", () => {
		expect(findPersona("writer")?.name).toBe("writer");
	});
});
