import { describe, expect, it } from "vitest";
import {
	CHUNK_SIZE,
	computeHashesForLines,
	computeLineHashes,
	encodeHash,
	findShifted,
	lineHash,
	parseAnchor,
	renderAnchoredLine,
	validateAnchor,
} from "../src/core/tools/hashline.ts";

describe("hashline", () => {
	it("lineHash is deterministic and whitespace-normalized", () => {
		expect(lineHash("const x = 1;")).toBe(lineHash("  const x = 1;  "));
		expect(lineHash("const  x =\t1;")).toBe(lineHash("const x = 1;"));
		// But content changes matter.
		expect(lineHash("return x")).not.toBe(lineHash("returnx"));
	});

	it("encodeHash produces lowercase letters of the requested length", () => {
		expect(encodeHash(lineHash("hello"))).toMatch(/^[a-z]{3}$/);
	});

	it("identical lines share the same local hash regardless of position", () => {
		const hashes = computeHashesForLines(["same", "other", "same"]);
		expect(hashes[0]![0]).toBe(hashes[2]![0]);
	});

	it("computeLineHashes returns one entry per line, in source order", () => {
		// Trailing newline produces a 4th empty line — the file genuinely
		// ends with one. That's the same shape `read`/`edit` operate on.
		const hashes = computeLineHashes("alpha\nbeta\ngamma\n");
		expect(hashes).toHaveLength(4);
		expect(hashes[0]![0]).toMatch(/^[a-z]{3}$/);
		expect(hashes[0]![1]).toMatch(/^[a-z]{3}$/);
		expect(hashes[2]![0]).not.toBe(hashes[0]![0]);
	});

	it("editing one line changes the chunk fingerprint of its whole chunk", () => {
		const before = computeHashesForLines(["a", "b", "c", "d"]);
		const after = computeHashesForLines(["a", "B", "c", "d"]);
		// Local hashes of untouched lines are stable...
		expect(after[0]![0]).toBe(before[0]![0]);
		expect(after[2]![0]).toBe(before[2]![0]);
		// ...but the shared chunk fingerprint drifts.
		expect(after[0]![1]).not.toBe(before[0]![1]);
	});

	it("lines in different chunks are unaffected by a distant edit", () => {
		const lines = Array.from({ length: CHUNK_SIZE * 2 }, (_, i) => `line ${i}`);
		const before = computeHashesForLines(lines);
		const mutated = lines.slice();
		mutated[0] = "CHANGED";
		const after = computeHashesForLines(mutated);
		const idx = CHUNK_SIZE; // first line of the second chunk
		expect(after[idx]).toEqual(before[idx]);
	});

	it("renderAnchoredLine carries the line content verbatim", () => {
		const gutter = renderAnchoredLine(12, ["abc", "rst"], "\t\tconst x = 1;");
		expect(gutter).toBe("12:abc:rst→\t\tconst x = 1;");
	});

	it("parseAnchor accepts full and truncated forms", () => {
		expect(parseAnchor("42:abc:rst")).toEqual({ line: 42, localHash: "abc", chunkHash: "rst" });
		expect(parseAnchor("42:abc")).toEqual({ line: 42, localHash: "abc" });
	});

	it("parseAnchor tolerates a pasted gutter — arrow and line content are dropped", () => {
		// Models copy the whole `22:abc:rst→content` gutter instead of just
		// the anchor; everything from the arrow onward must be ignored.
		expect(parseAnchor("4:ddg:qwi→")).toEqual({ line: 4, localHash: "ddg", chunkHash: "qwi" });
		expect(parseAnchor("22:abc:rst→\tconst x = 1;")).toEqual({ line: 22, localHash: "abc", chunkHash: "rst" });
		expect(parseAnchor("  22:abc:rst  ")).toEqual({ line: 22, localHash: "abc", chunkHash: "rst" });
	});

	it("parseAnchor rejects garbage", () => {
		expect(parseAnchor("abc")).toBeNull();
		expect(parseAnchor(":abc")).toBeNull();
		expect(parseAnchor("42:")).toBeNull();
		expect(parseAnchor("42:ABC")).toBeNull();
		expect(parseAnchor("42:abc:rst:extra")).toBeNull();
		expect(parseAnchor("42:abc123")).toBeNull(); // digits are not part of the hash alphabet
		expect(parseAnchor("")).toBeNull();
	});

	it("validateAnchor accepts a fresh full anchor and rejects drift", () => {
		const lines = ["alpha", "beta", "gamma"];
		const hashes = computeHashesForLines(lines);
		const fresh = { line: 2, localHash: hashes[1]![0], chunkHash: hashes[1]![1] };
		expect(validateAnchor(fresh, hashes)).toBe("valid");
		// Truncated anchor (no chunk) must not silently weaken validation.
		expect(validateAnchor({ line: 2, localHash: hashes[1]![0] }, hashes)).toBe("stale");
		expect(validateAnchor({ ...fresh, line: 99 }, hashes)).toBe("out_of_range");
		// Neighbouring edit within the chunk goes stale even though the
		// line itself is untouched.
		const drifted = computeHashesForLines(["alpha", "beta", "GAMMA"]);
		expect(validateAnchor(fresh, drifted)).toBe("stale");
	});

	it("findShifted recovers a uniquely moved line", () => {
		const lines = ["one", "two", "three"];
		const hashes = computeHashesForLines(lines);
		const anchor = { line: 2, localHash: hashes[1]![0] }; // "two", chunk omitted
		// "two" moved down by one after an insertion above.
		const shifted = computeHashesForLines(["inserted", "one", "two", "three"]);
		const result = findShifted(anchor, shifted);
		expect(result).toEqual({ kind: "found", newLine: 3 });
	});

	it("findShifted reports ambiguity when several nearby lines match", () => {
		const hashes = computeHashesForLines(["dup", "x", "dup", "dup"]);
		const result = findShifted({ line: 2, localHash: hashes[0]![0] }, hashes);
		expect(result?.kind).toBe("ambiguous");
	});

	it("findShifted returns null when the content is gone", () => {
		const hashes = computeHashesForLines(["one", "two", "three"]);
		const result = findShifted({ line: 2, localHash: "zzz" }, hashes);
		expect(result).toBeNull();
	});
});
