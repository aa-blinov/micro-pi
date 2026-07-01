import { describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/ui/input/keybindings.ts";
import { decodePrintableKey, Key, matchesKey } from "../src/ui/input/keys.ts";

describe("keys.ts — matchesKey", () => {
	it("matches Enter (\\r)", () => {
		expect(matchesKey("\r", Key.enter)).toBe(true);
	});

	it("matches Ctrl-J (\\n) as enter in legacy mode", () => {
		expect(matchesKey("\n", Key.enter)).toBe(true);
	});

	it("matches Backspace (\\x7f)", () => {
		expect(matchesKey("\x7f", Key.backspace)).toBe(true);
	});

	it("matches Ctrl-C", () => {
		expect(matchesKey("\x03", Key.ctrl("c"))).toBe(true);
	});

	it("matches Ctrl-C sent as a Kitty CSI-u sequence with the Cyrillic layout codepoint", () => {
		// Real terminal capture (Kitty protocol active, Russian/ЙЦУКЕН layout,
		// physical Ctrl+C key): the terminal reports codepoint 1089 (Cyrillic
		// "с") instead of the physical/Latin one, with no base-layout sub-field.
		expect(matchesKey("\x1b[1089;5u", Key.ctrl("c"))).toBe(true);
	});

	it("does not let the Cyrillic Ctrl-C fallback misfire as Ctrl-A", () => {
		// Cyrillic "с" is U+0441 (1089) — a full codepoint match here, unlike
		// the earlier reverted raw-byte-masking approach where Ctrl+A (\x01)
		// and a masked Cyrillic "с" byte collided on the same value.
		expect(matchesKey("\x1b[1089;5u", Key.ctrl("a"))).toBe(false);
	});

	it("matches Ctrl-G", () => {
		expect(matchesKey("\x07", Key.ctrl("g"))).toBe(true);
	});

	it("matches Esc", () => {
		expect(matchesKey("\x1b", Key.escape)).toBe(true);
	});

	it("matches arrow keys", () => {
		expect(matchesKey("\x1b[A", Key.up)).toBe(true);
		expect(matchesKey("\x1b[B", Key.down)).toBe(true);
		expect(matchesKey("\x1b[C", Key.right)).toBe(true);
		expect(matchesKey("\x1b[D", Key.left)).toBe(true);
	});

	it("matches Home/End", () => {
		expect(matchesKey("\x1b[H", Key.home)).toBe(true);
		expect(matchesKey("\x1b[F", Key.end)).toBe(true);
	});

	it("matches Delete", () => {
		expect(matchesKey("\x1b[3~", Key.delete)).toBe(true);
	});

	it("matches Ctrl-A (line start)", () => {
		expect(matchesKey("\x01", Key.ctrl("a"))).toBe(true);
	});

	it("matches Ctrl-E (line end)", () => {
		expect(matchesKey("\x05", Key.ctrl("e"))).toBe(true);
	});

	it("matches Ctrl-W (delete word backward)", () => {
		expect(matchesKey("\x17", Key.ctrl("w"))).toBe(true);
	});

	it("matches Ctrl-U (delete to line start)", () => {
		expect(matchesKey("\x15", Key.ctrl("u"))).toBe(true);
	});

	it("matches Ctrl-K (delete to line end)", () => {
		expect(matchesKey("\x0b", Key.ctrl("k"))).toBe(true);
	});

	it("matches Ctrl-D (delete forward)", () => {
		expect(matchesKey("\x04", Key.ctrl("d"))).toBe(true);
	});

	it("matches Ctrl-F (cursor right)", () => {
		expect(matchesKey("\x06", Key.ctrl("f"))).toBe(true);
	});

	it("matches Ctrl-B (cursor left)", () => {
		expect(matchesKey("\x02", Key.ctrl("b"))).toBe(true);
	});

	it("matches Alt-Left", () => {
		expect(matchesKey("\x1bb", Key.alt("left"))).toBe(true);
	});

	it("matches Alt-Right", () => {
		expect(matchesKey("\x1bf", Key.alt("right"))).toBe(true);
	});

	it("matches Alt-Backspace", () => {
		expect(matchesKey("\x1b\x7f", Key.alt("backspace"))).toBe(true);
	});

	it("matches printable char 'a'", () => {
		expect(matchesKey("a", "a")).toBe(true);
	});

	it("does not match wrong key", () => {
		expect(matchesKey("a", "b")).toBe(false);
		expect(matchesKey("\x1b[A", Key.down)).toBe(false);
	});

	it("matches CSI-u Shift+Enter (\\x1b[13;2u)", () => {
		expect(matchesKey("\x1b[13;2u", Key.shift("enter"))).toBe(true);
	});

	it("matches modifyOtherKeys Shift+Enter (\\x1b[27;2;13~)", () => {
		expect(matchesKey("\x1b[27;2;13~", Key.shift("enter"))).toBe(true);
	});

	it("does not match xterm-style \\x1b[13;2~ as Shift+Enter (non-standard)", () => {
		// \x1b[13;2~ is key 13 with shift modifier — not a standard Shift+Enter
		// sequence. Standard ones are \x1b[13;2u (CSI-u) and \x1b[27;2;13~ (modifyOtherKeys).
		expect(matchesKey("\x1b[13;2~", Key.shift("enter"))).toBe(false);
	});
});

describe("keys.ts — decodePrintableKey", () => {
	it("decodes CSI-u 'a' (\\x1b[97u)", () => {
		expect(decodePrintableKey("\x1b[97u")).toBe("a");
	});

	it("decodes CSI-u shifted key (shift modifier present)", () => {
		expect(decodePrintableKey("\x1b[97:65;2u")).toBe("A");
	});

	it("returns undefined for non-printable", () => {
		expect(decodePrintableKey("\x1b[A")).toBeUndefined();
	});
});

describe("keybindings.ts — KeybindingsManager", () => {
	it("matches submit binding to Enter", () => {
		const km = new KeybindingsManager();
		expect(km.matches("\r", "input.submit")).toBe(true);
		expect(km.matches("a", "input.submit")).toBe(false);
	});

	it("matches newLine binding to Shift+Enter", () => {
		const km = new KeybindingsManager();
		expect(km.matches("\x1b[13;2u", "input.newLine")).toBe(true);
	});

	it("matches newLine binding to Ctrl-J", () => {
		const km = new KeybindingsManager();
		expect(km.matches("\n", "input.newLine")).toBe(true);
	});

	it("matches abort binding to Ctrl-C", () => {
		const km = new KeybindingsManager();
		expect(km.matches("\x03", "input.abort")).toBe(true);
	});

	it("matches escape binding to Esc", () => {
		const km = new KeybindingsManager();
		expect(km.matches("\x1b", "input.escape")).toBe(true);
	});

	it("matches deleteWordBackward to Ctrl-W", () => {
		const km = new KeybindingsManager();
		expect(km.matches("\x17", "editor.deleteWordBackward")).toBe(true);
	});

	it("matches deleteToLineStart to Ctrl-U", () => {
		const km = new KeybindingsManager();
		expect(km.matches("\x15", "editor.deleteToLineStart")).toBe(true);
	});

	it("matches deleteToLineEnd to Ctrl-K", () => {
		const km = new KeybindingsManager();
		expect(km.matches("\x0b", "editor.deleteToLineEnd")).toBe(true);
	});

	it("matches cursorWordLeft to Alt-Left", () => {
		const km = new KeybindingsManager();
		expect(km.matches("\x1bb", "editor.cursorWordLeft")).toBe(true);
	});

	it("matches cursorLineStart to Home", () => {
		const km = new KeybindingsManager();
		expect(km.matches("\x1b[H", "editor.cursorLineStart")).toBe(true);
	});

	it("supports user overrides", () => {
		const km = new KeybindingsManager({ "input.submit": "ctrl+s" });
		expect(km.matches("\x13", "input.submit")).toBe(true);
		expect(km.matches("\r", "input.submit")).toBe(false);
	});
});
