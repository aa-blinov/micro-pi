/**
 * Keyboard input handling — ported from pi's packages/tui/src/keys.ts.
 *
 * Supports Kitty keyboard protocol (CSI u), xterm modifyOtherKeys, and
 * legacy terminal sequences. Matches raw input against typed key identifiers.
 *
 * See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
 */

let _kittyProtocolActive = false;

export function setKittyProtocolActive(active: boolean): void {
	_kittyProtocolActive = active;
}

type Letter =
	| "a"
	| "b"
	| "c"
	| "d"
	| "e"
	| "f"
	| "g"
	| "h"
	| "i"
	| "j"
	| "k"
	| "l"
	| "m"
	| "n"
	| "o"
	| "p"
	| "q"
	| "r"
	| "s"
	| "t"
	| "u"
	| "v"
	| "w"
	| "x"
	| "y"
	| "z";

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

type SymbolKey =
	| "`"
	| "-"
	| "="
	| "["
	| "]"
	| "\\"
	| ";"
	| "'"
	| ","
	| "."
	| "/"
	| "!"
	| "@"
	| "#"
	| "$"
	| "%"
	| "^"
	| "&"
	| "*"
	| "("
	| ")"
	| "_"
	| "+"
	| "|"
	| "~"
	| "{"
	| "}"
	| ":"
	| "<"
	| ">"
	| "?";

type SpecialKey =
	| "escape"
	| "esc"
	| "enter"
	| "return"
	| "tab"
	| "space"
	| "backspace"
	| "delete"
	| "insert"
	| "clear"
	| "home"
	| "end"
	| "pageUp"
	| "pageDown"
	| "up"
	| "down"
	| "left"
	| "right"
	| "f1"
	| "f2"
	| "f3"
	| "f4"
	| "f5"
	| "f6"
	| "f7"
	| "f8"
	| "f9"
	| "f10"
	| "f11"
	| "f12";

type BaseKey = Letter | Digit | SymbolKey | SpecialKey;
type ModifierName = "ctrl" | "shift" | "alt" | "super";

type ModifiedKeyId<K extends string, M extends ModifierName = ModifierName> = {
	[V in M]: `${V}+${K}` | `${V}+${ModifiedKeyId<K, Exclude<M, V>>}`;
}[M];

export type KeyId = BaseKey | ModifiedKeyId<BaseKey>;

export const Key = {
	escape: "escape" as const,
	esc: "esc" as const,
	enter: "enter" as const,
	return: "return" as const,
	tab: "tab" as const,
	space: "space" as const,
	backspace: "backspace" as const,
	delete: "delete" as const,
	insert: "insert" as const,
	clear: "clear" as const,
	home: "home" as const,
	end: "end" as const,
	pageUp: "pageUp" as const,
	pageDown: "pageDown" as const,
	up: "up" as const,
	down: "down" as const,
	left: "left" as const,
	right: "right" as const,
	f1: "f1" as const,
	f2: "f2" as const,
	f3: "f3" as const,
	f4: "f4" as const,
	f5: "f5" as const,
	f6: "f6" as const,
	f7: "f7" as const,
	f8: "f8" as const,
	f9: "f9" as const,
	f10: "f10" as const,
	f11: "f11" as const,
	f12: "f12" as const,
	ctrl: <K extends BaseKey>(key: K): `ctrl+${K}` => `ctrl+${key}`,
	shift: <K extends BaseKey>(key: K): `shift+${K}` => `shift+${key}`,
	alt: <K extends BaseKey>(key: K): `alt+${K}` => `alt+${key}`,
	super: <K extends BaseKey>(key: K): `super+${K}` => `super+${key}`,
	ctrlShift: <K extends BaseKey>(key: K): `ctrl+shift+${K}` => `ctrl+shift+${key}`,
	ctrlAlt: <K extends BaseKey>(key: K): `ctrl+alt+${K}` => `ctrl+alt+${key}`,
	shiftAlt: <K extends BaseKey>(key: K): `shift+alt+${K}` => `shift+alt+${key}`,
	ctrlSuper: <K extends BaseKey>(key: K): `ctrl+super+${K}` => `ctrl+super+${key}`,
} as const;

const SYMBOL_KEYS = new Set([
	"`",
	"-",
	"=",
	"[",
	"]",
	"\\",
	";",
	"'",
	",",
	".",
	"/",
	"!",
	"@",
	"#",
	"$",
	"%",
	"^",
	"&",
	"*",
	"(",
	")",
	"_",
	"+",
	"|",
	"~",
	"{",
	"}",
	":",
	"<",
	">",
	"?",
]);

const MODIFIERS = { shift: 1, alt: 2, ctrl: 4, super: 8 } as const;
const LOCK_MASK = 64 + 128;

const CODEPOINTS = {
	escape: 27,
	tab: 9,
	enter: 13,
	space: 32,
	backspace: 127,
	kpEnter: 57414,
} as const;

const ARROW_CODEPOINTS = { up: -1, down: -2, right: -3, left: -4 } as const;

const FUNCTIONAL_CODEPOINTS = {
	delete: -10,
	insert: -11,
	pageUp: -12,
	pageDown: -13,
	home: -14,
	end: -15,
} as const;

const KITTY_FUNCTIONAL_KEY_EQUIVALENTS = new Map<number, number>([
	[57399, 48],
	[57400, 49],
	[57401, 50],
	[57402, 51],
	[57403, 52],
	[57404, 53],
	[57405, 54],
	[57406, 55],
	[57407, 56],
	[57408, 57],
	[57409, 46],
	[57410, 47],
	[57411, 42],
	[57412, 45],
	[57413, 43],
	[57415, 61],
	[57416, 44],
	[57417, ARROW_CODEPOINTS.left],
	[57418, ARROW_CODEPOINTS.right],
	[57419, ARROW_CODEPOINTS.up],
	[57420, ARROW_CODEPOINTS.down],
	[57421, FUNCTIONAL_CODEPOINTS.pageUp],
	[57422, FUNCTIONAL_CODEPOINTS.pageDown],
	[57423, FUNCTIONAL_CODEPOINTS.home],
	[57424, FUNCTIONAL_CODEPOINTS.end],
	[57425, FUNCTIONAL_CODEPOINTS.insert],
	[57426, FUNCTIONAL_CODEPOINTS.delete],
]);

function normalizeKittyFunctionalCodepoint(cp: number): number {
	return KITTY_FUNCTIONAL_KEY_EQUIVALENTS.get(cp) ?? cp;
}

function normalizeShiftedLetterCodepoint(cp: number, mod: number): number {
	if ((mod & ~LOCK_MASK & MODIFIERS.shift) !== 0 && cp >= 65 && cp <= 90) return cp + 32;
	return cp;
}

function rawCtrlChar(key: string): string | null {
	const char = key.toLowerCase();
	const code = char.charCodeAt(0);
	if ((code >= 97 && code <= 122) || char === "[" || char === "\\" || char === "]" || char === "_") {
		return String.fromCharCode(code & 0x1f);
	}
	if (char === "-") return String.fromCharCode(31);
	return null;
}

// Cyrillic-to-Latin mapping for Russian QWERTY layout.
// When the keyboard is in Russian layout, pressing Alt+physical-B sends
// \x1bб (ESC + Cyrillic б) instead of \x1bb (ESC + Latin b). This mapping
// lets us match Alt+б as Alt+b so keybindings work regardless of layout.
const CYRILLIC_BY_LATIN: Record<string, string> = {
	a: "ф",
	b: "и",
	c: "с",
	d: "в",
	e: "у",
	f: "а",
	g: "п",
	h: "р",
	i: "ш",
	j: "о",
	k: "л",
	l: "д",
	m: "ь",
	n: "т",
	o: "щ",
	p: "з",
	q: "й",
	r: "к",
	s: "ы",
	t: "е",
	u: "г",
	v: "м",
	w: "ц",
	x: "ч",
	y: "н",
	z: "я",
};

// =============================================================================
// Kitty CSI-u parsing
// =============================================================================

interface ParsedKittySequence {
	codepoint: number;
	shiftedKey?: number;
	baseLayoutKey?: number;
	modifier: number;
}

function parseKittySequence(data: string): ParsedKittySequence | null {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
	const csiUMatch = data.match(/^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::\d+)?u$/);
	if (csiUMatch) {
		const codepoint = parseInt(csiUMatch[1]!, 10);
		const shiftedKey = csiUMatch[2] && csiUMatch[2].length > 0 ? parseInt(csiUMatch[2], 10) : undefined;
		const baseLayoutKey = csiUMatch[3] ? parseInt(csiUMatch[3], 10) : undefined;
		const modValue = csiUMatch[4] ? parseInt(csiUMatch[4], 10) : 1;
		return { codepoint, shiftedKey, baseLayoutKey, modifier: modValue - 1 };
	}

	// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
	const arrowMatch = data.match(/^\x1b\[1;(\d+)(?::\d+)?([ABCD])$/);
	if (arrowMatch) {
		const modValue = parseInt(arrowMatch[1]!, 10);
		const arrowCodes: Record<string, number> = { A: -1, B: -2, C: -3, D: -4 };
		return { codepoint: arrowCodes[arrowMatch[3]!]!, modifier: modValue - 1 };
	}

	// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
	const funcMatch = data.match(/^\x1b\[(\d+)(?:;(\d+))?(?::\d+)?~$/);
	if (funcMatch) {
		const keyNum = parseInt(funcMatch[1]!, 10);
		const modValue = funcMatch[2] ? parseInt(funcMatch[2], 10) : 1;
		const funcCodes: Record<number, number> = {
			2: FUNCTIONAL_CODEPOINTS.insert,
			3: FUNCTIONAL_CODEPOINTS.delete,
			5: FUNCTIONAL_CODEPOINTS.pageUp,
			6: FUNCTIONAL_CODEPOINTS.pageDown,
			7: FUNCTIONAL_CODEPOINTS.home,
			8: FUNCTIONAL_CODEPOINTS.end,
		};
		const codepoint = funcCodes[keyNum];
		if (codepoint !== undefined) return { codepoint, modifier: modValue - 1 };
	}

	// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
	const homeEndMatch = data.match(/^\x1b\[1;(\d+)(?::\d+)?([HF])$/);
	if (homeEndMatch) {
		const modValue = parseInt(homeEndMatch[1]!, 10);
		const codepoint = homeEndMatch[3] === "H" ? FUNCTIONAL_CODEPOINTS.home : FUNCTIONAL_CODEPOINTS.end;
		return { codepoint, modifier: modValue - 1 };
	}

	return null;
}

function parseModifyOtherKeysSequence(data: string): { codepoint: number; modifier: number } | null {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
	const match = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
	if (!match) return null;
	return { codepoint: parseInt(match[2]!, 10), modifier: parseInt(match[1]!, 10) - 1 };
}

function matchesKittySequence(data: string, expectedCodepoint: number, expectedModifier: number): boolean {
	const parsed = parseKittySequence(data);
	if (!parsed) return false;
	const actualMod = parsed.modifier & ~LOCK_MASK;
	const expectedMod = expectedModifier & ~LOCK_MASK;
	if (actualMod !== expectedMod) return false;
	const normalizedCp = normalizeShiftedLetterCodepoint(
		normalizeKittyFunctionalCodepoint(parsed.codepoint),
		parsed.modifier,
	);
	const normalizedExpected = normalizeShiftedLetterCodepoint(
		normalizeKittyFunctionalCodepoint(expectedCodepoint),
		expectedModifier,
	);
	if (normalizedCp === normalizedExpected) return true;
	if (parsed.baseLayoutKey !== undefined && parsed.baseLayoutKey === expectedCodepoint) {
		const cp = normalizedCp;
		if (!(cp >= 97 && cp <= 122) && !SYMBOL_KEYS.has(String.fromCharCode(cp))) return true;
	}
	return false;
}

function matchesModifyOtherKeys(data: string, expectedKeycode: number, expectedModifier: number): boolean {
	const parsed = parseModifyOtherKeysSequence(data);
	if (!parsed) return false;
	return parsed.codepoint === expectedKeycode && parsed.modifier === expectedModifier;
}

function matchesPrintableModifyOtherKeys(data: string, expectedKeycode: number, expectedModifier: number): boolean {
	if (expectedModifier === 0) return false;
	const parsed = parseModifyOtherKeysSequence(data);
	if (!parsed || parsed.modifier !== expectedModifier) return false;
	return (
		normalizeShiftedLetterCodepoint(parsed.codepoint, parsed.modifier) ===
		normalizeShiftedLetterCodepoint(expectedKeycode, expectedModifier)
	);
}

// =============================================================================
// matchesKey — check if raw input matches a key identifier
// =============================================================================

function parseKeyId(
	keyId: string,
): { key: string; ctrl: boolean; shift: boolean; alt: boolean; super: boolean } | null {
	const parts = keyId.toLowerCase().split("+");
	const key = parts[parts.length - 1];
	if (!key) return null;
	return {
		key,
		ctrl: parts.includes("ctrl"),
		shift: parts.includes("shift"),
		alt: parts.includes("alt"),
		super: parts.includes("super"),
	};
}

export function matchesKey(data: string, keyId: KeyId): boolean {
	const parsed = parseKeyId(keyId);
	if (!parsed) return false;

	const { key, ctrl, shift, alt, super: superModifier } = parsed;
	let modifier = 0;
	if (shift) modifier |= MODIFIERS.shift;
	if (alt) modifier |= MODIFIERS.alt;
	if (ctrl) modifier |= MODIFIERS.ctrl;
	if (superModifier) modifier |= MODIFIERS.super;

	switch (key) {
		case "escape":
		case "esc":
			if (modifier !== 0) return false;
			return (
				data === "\x1b" ||
				matchesKittySequence(data, CODEPOINTS.escape, 0) ||
				matchesModifyOtherKeys(data, CODEPOINTS.escape, 0)
			);

		case "space":
			if (modifier === MODIFIERS.ctrl && data === "\x00") return true;
			if (modifier === MODIFIERS.alt && data === "\x1b ") return true;
			if (modifier === 0)
				return (
					data === " " ||
					matchesKittySequence(data, CODEPOINTS.space, 0) ||
					matchesModifyOtherKeys(data, CODEPOINTS.space, 0)
				);
			return (
				matchesKittySequence(data, CODEPOINTS.space, modifier) ||
				matchesModifyOtherKeys(data, CODEPOINTS.space, modifier)
			);

		case "tab":
			if (modifier === MODIFIERS.shift)
				return (
					data === "\x1b[Z" ||
					matchesKittySequence(data, CODEPOINTS.tab, MODIFIERS.shift) ||
					matchesModifyOtherKeys(data, CODEPOINTS.tab, MODIFIERS.shift)
				);
			if (modifier === 0) return data === "\t" || matchesKittySequence(data, CODEPOINTS.tab, 0);
			return (
				matchesKittySequence(data, CODEPOINTS.tab, modifier) ||
				matchesModifyOtherKeys(data, CODEPOINTS.tab, modifier)
			);

		case "enter":
		case "return":
			if (modifier === MODIFIERS.shift) {
				if (
					matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.shift) ||
					matchesKittySequence(data, CODEPOINTS.kpEnter, MODIFIERS.shift)
				)
					return true;
				if (matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.shift)) return true;
				if (_kittyProtocolActive) return data === "\x1b\r" || data === "\n";
				return false;
			}
			if (modifier === MODIFIERS.alt) {
				if (
					matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.alt) ||
					matchesKittySequence(data, CODEPOINTS.kpEnter, MODIFIERS.alt)
				)
					return true;
				if (matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.alt)) return true;
				if (!_kittyProtocolActive) return data === "\x1b\r";
				return false;
			}
			if (modifier === 0) {
				return (
					data === "\r" ||
					(!_kittyProtocolActive && data === "\n") ||
					data === "\x1bOM" ||
					matchesKittySequence(data, CODEPOINTS.enter, 0) ||
					matchesKittySequence(data, CODEPOINTS.kpEnter, 0)
				);
			}
			return (
				matchesKittySequence(data, CODEPOINTS.enter, modifier) ||
				matchesKittySequence(data, CODEPOINTS.kpEnter, modifier) ||
				matchesModifyOtherKeys(data, CODEPOINTS.enter, modifier)
			);

		case "backspace":
			if (modifier === MODIFIERS.alt)
				return (
					data === "\x1b\x7f" ||
					data === "\x1b\b" ||
					matchesKittySequence(data, CODEPOINTS.backspace, MODIFIERS.alt) ||
					matchesModifyOtherKeys(data, CODEPOINTS.backspace, MODIFIERS.alt)
				);
			if (modifier === MODIFIERS.ctrl)
				return (
					data === "\x08" ||
					matchesKittySequence(data, CODEPOINTS.backspace, MODIFIERS.ctrl) ||
					matchesModifyOtherKeys(data, CODEPOINTS.backspace, MODIFIERS.ctrl)
				);
			if (modifier === 0)
				return (
					data === "\x7f" ||
					data === "\x08" ||
					matchesKittySequence(data, CODEPOINTS.backspace, 0) ||
					matchesModifyOtherKeys(data, CODEPOINTS.backspace, 0)
				);
			return (
				matchesKittySequence(data, CODEPOINTS.backspace, modifier) ||
				matchesModifyOtherKeys(data, CODEPOINTS.backspace, modifier)
			);

		case "delete":
			if (modifier === 0) return data === "\x1b[3~" || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.delete, 0);
			if (modifier === MODIFIERS.shift)
				return data === "\x1b[3$" || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.delete, MODIFIERS.shift);
			if (modifier === MODIFIERS.ctrl)
				return data === "\x1b[3^" || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.delete, MODIFIERS.ctrl);
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.delete, modifier);

		case "insert":
			if (modifier === 0) return data === "\x1b[2~" || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.insert, 0);
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.insert, modifier);

		case "home":
			if (modifier === 0)
				return (
					data === "\x1b[H" ||
					data === "\x1bOH" ||
					data === "\x1b[7~" ||
					matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.home, 0)
				);
			if (modifier === MODIFIERS.shift)
				return data === "\x1b[7$" || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.home, MODIFIERS.shift);
			if (modifier === MODIFIERS.ctrl)
				return data === "\x1b[7^" || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.home, MODIFIERS.ctrl);
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.home, modifier);

		case "end":
			if (modifier === 0)
				return (
					data === "\x1b[F" ||
					data === "\x1bOF" ||
					data === "\x1b[8~" ||
					matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.end, 0)
				);
			if (modifier === MODIFIERS.shift)
				return data === "\x1b[8$" || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.end, MODIFIERS.shift);
			if (modifier === MODIFIERS.ctrl)
				return data === "\x1b[8^" || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.end, MODIFIERS.ctrl);
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.end, modifier);

		case "pageUp":
			if (modifier === 0) return data === "\x1b[5~" || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageUp, 0);
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageUp, modifier);

		case "pageDown":
			if (modifier === 0) return data === "\x1b[6~" || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageDown, 0);
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageDown, modifier);

		case "up":
			if (modifier === MODIFIERS.shift)
				return data === "\x1b[a" || matchesKittySequence(data, ARROW_CODEPOINTS.up, MODIFIERS.shift);
			if (modifier === MODIFIERS.ctrl)
				return (
					data === "\x1bOa" ||
					data === "\x1b[1;5A" ||
					matchesKittySequence(data, ARROW_CODEPOINTS.up, MODIFIERS.ctrl)
				);
			if (modifier === MODIFIERS.alt)
				return data === "\x1bp" || matchesKittySequence(data, ARROW_CODEPOINTS.up, MODIFIERS.alt);
			if (modifier === 0)
				return data === "\x1b[A" || data === "\x1bOA" || matchesKittySequence(data, ARROW_CODEPOINTS.up, 0);
			return matchesKittySequence(data, ARROW_CODEPOINTS.up, modifier);

		case "down":
			if (modifier === MODIFIERS.shift)
				return data === "\x1b[b" || matchesKittySequence(data, ARROW_CODEPOINTS.down, MODIFIERS.shift);
			if (modifier === MODIFIERS.ctrl)
				return (
					data === "\x1bOb" ||
					data === "\x1b[1;5B" ||
					matchesKittySequence(data, ARROW_CODEPOINTS.down, MODIFIERS.ctrl)
				);
			if (modifier === MODIFIERS.alt)
				return data === "\x1bn" || matchesKittySequence(data, ARROW_CODEPOINTS.down, MODIFIERS.alt);
			if (modifier === 0)
				return data === "\x1b[B" || data === "\x1bOB" || matchesKittySequence(data, ARROW_CODEPOINTS.down, 0);
			return matchesKittySequence(data, ARROW_CODEPOINTS.down, modifier);

		case "left":
			if (modifier === MODIFIERS.shift)
				return data === "\x1b[c" || matchesKittySequence(data, ARROW_CODEPOINTS.left, MODIFIERS.shift);
			if (modifier === MODIFIERS.ctrl)
				return (
					data === "\x1bOd" ||
					data === "\x1b[1;5D" ||
					matchesKittySequence(data, ARROW_CODEPOINTS.left, MODIFIERS.ctrl)
				);
			if (modifier === MODIFIERS.alt)
				return (
					data === "\x1bb" ||
					data === "\x1b[1;3D" ||
					(!_kittyProtocolActive && data === "\x1bB") ||
					matchesKittySequence(data, ARROW_CODEPOINTS.left, MODIFIERS.alt)
				);
			if (modifier === 0)
				return data === "\x1b[D" || data === "\x1bOD" || matchesKittySequence(data, ARROW_CODEPOINTS.left, 0);
			return matchesKittySequence(data, ARROW_CODEPOINTS.left, modifier);

		case "right":
			if (modifier === MODIFIERS.shift)
				return data === "\x1b[d" || matchesKittySequence(data, ARROW_CODEPOINTS.right, MODIFIERS.shift);
			if (modifier === MODIFIERS.ctrl)
				return (
					data === "\x1bOc" ||
					data === "\x1b[1;5C" ||
					matchesKittySequence(data, ARROW_CODEPOINTS.right, MODIFIERS.ctrl)
				);
			if (modifier === MODIFIERS.alt)
				return (
					data === "\x1bf" ||
					data === "\x1b[1;3C" ||
					(!_kittyProtocolActive && data === "\x1bF") ||
					matchesKittySequence(data, ARROW_CODEPOINTS.right, MODIFIERS.alt)
				);
			if (modifier === 0)
				return data === "\x1b[C" || data === "\x1bOC" || matchesKittySequence(data, ARROW_CODEPOINTS.right, 0);
			return matchesKittySequence(data, ARROW_CODEPOINTS.right, modifier);
	}

	// Single letter/digit/symbol keys
	if (key.length === 1 && ((key >= "a" && key <= "z") || (key >= "0" && key <= "9") || SYMBOL_KEYS.has(key))) {
		const codepoint = key.charCodeAt(0);
		const rawCtrl = rawCtrlChar(key);

		if (modifier === MODIFIERS.ctrl) {
			if (rawCtrl && data === rawCtrl) return true;
			if (
				matchesKittySequence(data, codepoint, MODIFIERS.ctrl) ||
				matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.ctrl)
			)
				return true;
			// Fallback for Cyrillic keyboard layout once the Kitty protocol is
			// active: the terminal reports Ctrl+<layout-letter> as a CSI-u sequence
			// carrying the *layout* character's codepoint (e.g. с = 1089 for
			// physical Ctrl+C), not the Latin one — confirmed via a real terminal
			// capture (`\x1b[1089;5u`) — and doesn't supply the Kitty "report
			// alternate keys" sub-field that would let matchesKittySequence's own
			// baseLayoutKey check resolve it. Matching the full Cyrillic Unicode
			// codepoint here (not a masked/truncated byte) is safe: unlike raw
			// ASCII control-byte masking — where Ctrl+A and Ctrl+Cyrillic-с both
			// collapse to the same 0x01 byte and were impossible to tell apart —
			// every Cyrillic letter keeps its own distinct codepoint in this field.
			const cyrillic = CYRILLIC_BY_LATIN[key];
			const cyrillicCodepoint = cyrillic?.codePointAt(0);
			if (cyrillicCodepoint !== undefined && matchesKittySequence(data, cyrillicCodepoint, MODIFIERS.ctrl))
				return true;
			return false;
		}

		if (modifier === MODIFIERS.shift) {
			if (key >= "a" && key <= "z" && data === key.toUpperCase()) return true;
			return (
				matchesKittySequence(data, codepoint, MODIFIERS.shift) ||
				matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.shift)
			);
		}

		if (modifier === MODIFIERS.alt) {
			// Not gated on !_kittyProtocolActive: some terminals (VS Code's
			// integrated one among them) answer just enough of the Kitty
			// handshake to flip that flag on — e.g. they disambiguate escape
			// codes — without actually honoring the "report alternate keys"
			// flag our push requests, so matchesKittySequence's baseLayoutKey
			// check below never gets the data it needs. Gating this on the
			// flag meant those terminals lost the raw-sequence fallback *and*
			// never got a working Kitty-based match either — every non-Latin-
			// layout Alt shortcut silently did nothing. The two formats don't
			// overlap, so checking both unconditionally is always safe.
			if (key >= "a" && key <= "z") {
				if (data === `\x1b${key}`) return true;
				// Fallback for Cyrillic keyboard layout: Alt+б sends \x1bб instead of \x1bb
				const cyrillic = CYRILLIC_BY_LATIN[key];
				if (cyrillic && data === `\x1b${cyrillic}`) return true;
			}
			return (
				matchesKittySequence(data, codepoint, MODIFIERS.alt) ||
				matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.alt)
			);
		}

		if (modifier !== 0) {
			return (
				matchesKittySequence(data, codepoint, modifier) ||
				matchesPrintableModifyOtherKeys(data, codepoint, modifier)
			);
		}

		return data === key || matchesKittySequence(data, codepoint, 0);
	}

	return false;
}

// =============================================================================
// decodePrintableKey — extract printable character from CSI-u / modifyOtherKeys
// =============================================================================

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
const KITTY_CSI_U_REGEX = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::\d+)?u$/;
const KITTY_PRINTABLE_ALLOWED_MODIFIERS = MODIFIERS.shift | LOCK_MASK;

export function decodePrintableKey(data: string): string | undefined {
	const match = data.match(KITTY_CSI_U_REGEX);
	if (match) {
		const codepoint = Number.parseInt(match[1] ?? "", 10);
		if (!Number.isFinite(codepoint)) return undefined;
		const shiftedKey = match[2] && match[2].length > 0 ? Number.parseInt(match[2], 10) : undefined;
		const modValue = match[4] ? Number.parseInt(match[4], 10) : 1;
		const modifier = Number.isFinite(modValue) ? modValue - 1 : 0;
		if ((modifier & ~KITTY_PRINTABLE_ALLOWED_MODIFIERS) !== 0) return undefined;
		if (modifier & (MODIFIERS.alt | MODIFIERS.ctrl)) return undefined;
		let effectiveCp = codepoint;
		if (modifier & MODIFIERS.shift && typeof shiftedKey === "number") effectiveCp = shiftedKey;
		effectiveCp = normalizeKittyFunctionalCodepoint(effectiveCp);
		if (!Number.isFinite(effectiveCp) || effectiveCp < 32) return undefined;
		try {
			return String.fromCodePoint(effectiveCp);
		} catch {
			return undefined;
		}
	}

	const modifyOtherKeys = parseModifyOtherKeysSequence(data);
	if (modifyOtherKeys) {
		const modifier = modifyOtherKeys.modifier & ~LOCK_MASK;
		if ((modifier & ~MODIFIERS.shift) !== 0) return undefined;
		if (!Number.isFinite(modifyOtherKeys.codepoint) || modifyOtherKeys.codepoint < 32) return undefined;
		try {
			return String.fromCodePoint(modifyOtherKeys.codepoint);
		} catch {
			return undefined;
		}
	}

	return undefined;
}
