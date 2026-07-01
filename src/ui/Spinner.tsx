import { Text } from "ink";
import { type JSX, useEffect, useState } from "react";
import { gradientHex } from "./gradient.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_COLORS = FRAMES.map((_, i) => gradientHex(i / (FRAMES.length - 1)));

/** Animated frame only, no label — shimmers through the banner's cyan→violet palette. */
export function Spinner(): JSX.Element {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
		return () => clearInterval(id);
	}, []);
	return <Text color={FRAME_COLORS[frame]}>{FRAMES[frame]}</Text>;
}
