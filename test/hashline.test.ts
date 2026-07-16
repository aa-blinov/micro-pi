import { describe, expect, it } from "vitest";
import { computeLineHashes, formatLineGutter, hash, parseAnchor, secondarySuffix } from "../src/core/tools/hashline.ts";

describe("hashline", () => {
	it("hash() is deterministic for the same input", () => {
		const a = hash(7, "const x = 1;", "let prev = 0;");
		const b = hash(7, "const x = 1;", "let prev = 0;");
		expect(a).toEqual(b);
		expect(a[0]).toMatch(/^[0-9a-f]{6}$/);
		expect(a[1]).toMatch(/^[0-9a-f]{3}$/);
	});

	it("different line numbers of the same content hash differently", () => {
		// A naive hash of just the line content would collide here; the
		// line-number mixer is what makes anchored edits unambiguous.
		const a = hash(1, "return 42;");
		const b = hash(2, "return 42;");
		expect(a[0]).not.toBe(b[0]);
	});

	it("secondary hash disambiguates identical neighbouring lines", () => {
		// Two adjacent blank-ish lines — same content, different prev.
		const a = hash(1, "same", "");
		const b = hash(2, "same", "same");
		expect(a[1]).not.toBe(b[1]);
	});

	it("computeLineHashes returns one entry per line, in source order", () => {
		// Trailing newline produces a 4th empty line — the file genuinely
		// ends with one. That's the same shape `read`/`edit` operate on.
		const hashes = computeLineHashes("alpha\nbeta\ngamma\n");
		expect(hashes).toHaveLength(4);
		// First line has no previous, so its secondary is computed with "".
		expect(hashes[0]![0]).toMatch(/^[0-9a-f]{6}$/);
		expect(hashes[2]![0]).not.toBe(hashes[0]![0]);
	});

	it("formatLineGutter shows the secondary only when it disambiguates", () => {
		const withNoSecondary = formatLineGutter({ lineNumber: 1, content: "unique-payload", prevContent: "" });
		// The exact primary/secondary values are implementation-detail; we
		// only assert the format and the elision rule.
		const match = /^(\d+):([0-9a-f]{6})(?::([0-9a-f]{3}))?→(.+)$/.exec(withNoSecondary);
		expect(match).not.toBeNull();
		expect(match?.[4]).toBe("unique-payload");
		expect(match?.[1]).toBe("1");
		// Whether the secondary is printed depends on the hash bytes; the
		// important contract is "if printed, it's the last 3 hex before →".
		if (match?.[3]) {
			expect(match[3]).toMatch(/^[0-9a-f]{3}$/);
		}
		// Round-trip: parsing the anchor we just built must reproduce the
		// line number and at least the primary hash.
		const parsed = parseAnchor(`${match?.[1]}:${match?.[2]}${match?.[3] ? `:${match[3]}` : ""}`);
		expect(parsed?.line).toBe(1);
		expect(parsed?.primaryHash).toBe(match?.[2]);
	});

	it("formatLineGutter carries the line content verbatim", () => {
		const gutter = formatLineGutter({ lineNumber: 12, content: "\t\tconst x = 1;", prevContent: "}" });
		expect(gutter).toMatch(/^12:[0-9a-f]{6}(?::[0-9a-f]{3})?→\t\tconst x = 1;$/);
	});

	it("secondarySuffix matches formatLineGutter's emitted secondary", () => {
		// For the exact same inputs, the secondary the model can paste back
		// (from secondarySuffix) must equal the one formatLineGutter
		// already wrote. This is the contract `grep` relies on.
		const lineNo = 17;
		const content = "const y = 2;";
		const prev = "const x = 1;";
		const gutter = formatLineGutter({ lineNumber: lineNo, content, prevContent: prev });
		const expected = secondarySuffix(lineNo, content, prev);
		const match = /^17:[0-9a-f]{6}(?::([0-9a-f]{3}))?→/.exec(gutter);
		const emitted = match?.[1] ?? "";
		expect(emitted).toBe(expected);
	});

	it("parseAnchor accepts both 1- and 2-token forms", () => {
		expect(parseAnchor("42:abc123")).toEqual({ line: 42, primaryHash: "abc123" });
		expect(parseAnchor("42:abc123:1f2")).toEqual({ line: 42, primaryHash: "abc123", secondaryHash: "1f2" });
	});

	it("parseAnchor rejects garbage", () => {
		expect(parseAnchor("abc123")).toBeNull();
		expect(parseAnchor("42:xyz")).toBeNull();
		expect(parseAnchor(":abc")).toBeNull();
		expect(parseAnchor("42:abc:1f2:extra")).toBeNull();
		expect(parseAnchor("")).toBeNull();
	});
});
