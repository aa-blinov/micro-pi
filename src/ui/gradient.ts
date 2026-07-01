/**
 * Shared cyan → violet palette — the "cast" banner's colors, reused for
 * the startup loader spinner and the composer's idle border so the brand
 * accent is consistent instead of every element picking its own color.
 */
const GRADIENT_FROM: [number, number, number] = [56, 224, 255]; // cyan
const GRADIENT_TO: [number, number, number] = [168, 85, 247]; // violet

function lerpColor(t: number): [number, number, number] {
	const clamped = Math.max(0, Math.min(1, t));
	return [0, 1, 2].map((i) => Math.round(GRADIENT_FROM[i]! + (GRADIENT_TO[i]! - GRADIENT_FROM[i]!) * clamped)) as [
		number,
		number,
		number,
	];
}

function toHex(rgb: [number, number, number]): string {
	return `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Hex color at position `t` (0 = cyan, 1 = violet) along the palette. */
export function gradientHex(t: number): string {
	return toHex(lerpColor(t));
}

/**
 * Per-character truecolor gradient, bold, as raw ANSI codes — for text
 * printed outside the Ink tree (plain console.log), where there's no <Text>
 * to hand a color prop to.
 */
export function gradientAnsi(text: string): string {
	const chars = [...text];
	const steps = Math.max(1, chars.length - 1);
	const painted = chars
		.map((ch, i) => {
			const [r, g, b] = lerpColor(i / steps);
			return `\x1b[38;2;${r};${g};${b}m${ch}`;
		})
		.join("");
	return `\x1b[1m${painted}\x1b[0m`;
}

/**
 * Multi-line banner with continuous per-character gradient across all lines
 * (gradient flows top-left → bottom-right, not restarting per line).
 * Returns pre-formatted ANSI string ready for console.log.
 */
export function gradientBanner(banner: string, version: string): string {
	const lines = banner.split("\n");
	// Flatten all characters across lines to compute a single gradient pass
	const allChars: string[] = [];
	for (const line of lines) allChars.push(...[...line], "\n");
	// Drop the trailing newline from the split
	if (allChars[allChars.length - 1] === "\n") allChars.pop();
	const total = Math.max(1, allChars.length - 1);
	let charIdx = 0;
	const result: string[] = [];
	for (const line of lines) {
		const chars = [...line];
		const painted = chars
			.map((ch) => {
				const [r, g, b] = lerpColor(charIdx / total);
				charIdx++;
				return `\x1b[38;2;${r};${g};${b}m${ch}`;
			})
			.join("");
		result.push(`\x1b[1m${painted}\x1b[0m`);
	}
	// Version line: dim, left-aligned under the banner
	result.push("");
	result.push(`\x1b[2mv${version}\x1b[0m`);
	return result.join("\n");
}
