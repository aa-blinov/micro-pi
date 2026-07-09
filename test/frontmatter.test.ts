import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../src/core/frontmatter.ts";

describe("parseFrontmatter", () => {
	it("returns empty frontmatter and the whole content as body when there's no block", () => {
		const { frontmatter, body } = parseFrontmatter("just a body\nmore text");
		expect(frontmatter).toEqual({});
		expect(body).toBe("just a body\nmore text");
	});

	it("treats an unterminated --- block as no frontmatter (body = whole)", () => {
		const input = "---\nname: x\nno closing fence";
		const { frontmatter, body } = parseFrontmatter(input);
		expect(frontmatter).toEqual({});
		expect(body).toBe(input);
	});

	it("parses scalar fields and strips the block from the body", () => {
		const { frontmatter, body } = parseFrontmatter("---\nname: hello\ndescription: a thing\n---\nBody here.");
		expect(frontmatter).toEqual({ name: "hello", description: "a thing" });
		expect(body).toBe("Body here.");
	});

	it("coerces true/false to booleans but leaves other words as strings", () => {
		const { frontmatter } = parseFrontmatter("---\na: true\nb: false\nc: truthy\n---\n");
		expect(frontmatter).toEqual({ a: true, b: false, c: "truthy" });
	});

	it("parses inline arrays, quoted or bare, and an empty array", () => {
		const { frontmatter } = parseFrontmatter('---\nglobs: ["*.ts", "*.tsx"]\ntags: [a, b]\nempty: []\n---\n');
		expect(frontmatter.globs).toEqual(["*.ts", "*.tsx"]);
		expect(frontmatter.tags).toEqual(["a", "b"]);
		expect(frontmatter.empty).toEqual([]);
	});

	it("strips surrounding single or double quotes from scalar values", () => {
		const { frontmatter } = parseFrontmatter(`---\na: "quoted"\nb: 'single'\n---\n`);
		expect(frontmatter).toEqual({ a: "quoted", b: "single" });
	});

	it("keeps everything after the first colon as the value (URLs, colons in text)", () => {
		const { frontmatter } = parseFrontmatter("---\nurl: https://example.com/v1\nnote: a: b\n---\n");
		expect(frontmatter.url).toBe("https://example.com/v1");
		expect(frontmatter.note).toBe("a: b");
	});

	it("skips lines that aren't key: value", () => {
		const { frontmatter } = parseFrontmatter("---\nname: ok\nthis is not a field\n# comment-ish\n---\n");
		expect(frontmatter).toEqual({ name: "ok" });
	});

	it("normalizes CRLF and drops the leading newline of the body", () => {
		const { frontmatter, body } = parseFrontmatter("---\r\nname: x\r\n---\r\nline1\r\nline2");
		expect(frontmatter).toEqual({ name: "x" });
		expect(body).toBe("line1\nline2");
	});

	it("accepts hyphens, underscores and digits in keys", () => {
		const { frontmatter } = parseFrontmatter("---\nmax-tokens: 5\nsome_key: v\nkey2: w\n---\n");
		expect(frontmatter).toEqual({ "max-tokens": "5", some_key: "v", key2: "w" });
	});
});
