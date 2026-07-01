import { Box, Text, useStdin } from "ink";
import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import { SLASH_COMMANDS } from "./commands.ts";
import { gradientHex } from "./gradient.ts";
import { type InputEvent, InputParser } from "./input/input-parser.ts";
import { TextBuffer } from "./input/textarea.ts";

const PROMPT_COLOR = gradientHex(0);
const BORDER_COLOR_ACTIVE = gradientHex(1);

interface ComposerProps {
	onSubmit: (text: string) => void;
	/** Return false to reject the submission (keeps the buffer intact). */
	canSubmit?: (text: string) => boolean;
	onAbort: () => void;
	onExit: () => void;
	onPasteImage?: () => Promise<string | null>;
	running: boolean;
	locked: boolean;
}

interface PendingPaste {
	placeholder: string;
	text: string;
}

// Multi-line pastes used to get inserted into the buffer verbatim — a big
// code block would blow the composer out to dozens of rows and the cursor-
// highlighting math (below) would visibly mangle it. Collapse pasted (not
// typed — see the "paste" event branch) multi-line text into a placeholder
// chip instead, like opencode's "Pasted N lines", and expand it back to the
// real text right before submitting.
const PASTE_PLACEHOLDER_RE = /\[Pasted \d+ lines\]/g;

/** Renders `text`, highlighting any paste-placeholder chips like opencode's. */
function renderWithPasteChips(text: string, keyPrefix: string): JSX.Element[] {
	if (!text) return [];
	const nodes: JSX.Element[] = [];
	let lastIndex = 0;
	let segment = 0;
	PASTE_PLACEHOLDER_RE.lastIndex = 0;
	let match: RegExpExecArray | null = PASTE_PLACEHOLDER_RE.exec(text);
	while (match) {
		if (match.index > lastIndex) {
			nodes.push(<Text key={`${keyPrefix}-${segment++}`}>{text.slice(lastIndex, match.index)}</Text>);
		}
		nodes.push(
			<Text key={`${keyPrefix}-${segment++}`} color="black" backgroundColor="yellow">
				{match[0]}
			</Text>,
		);
		lastIndex = match.index + match[0].length;
		match = PASTE_PLACEHOLDER_RE.exec(text);
	}
	if (lastIndex < text.length) {
		nodes.push(<Text key={`${keyPrefix}-${segment++}`}>{text.slice(lastIndex)}</Text>);
	}
	return nodes;
}

// Flags: 1 (disambiguate escape codes) | 4 (report alternate keys). The
// second flag is what makes a Kitty-protocol terminal include the base
// (physical/Latin) layout codepoint alongside the actual one — without it,
// pressing e.g. Alt+Cyrillic-и (physically where Alt+B sits on ЙЦУКЕН) never
// carries the "this is really B" hint, so keys.ts's Cyrillic-layout matching
// (see CYRILLIC_BY_LATIN, matchesKittySequence's baseLayoutKey check) never
// gets the data it needs and non-Latin-layout shortcuts silently do nothing.
const KITTY_PUSH = "\x1b[>5u";
const KITTY_POP = "\x1b[<u";
const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";
const PALETTE_ROWS = 8;

export function Composer({
	onSubmit,
	canSubmit,
	onAbort,
	onExit,
	onPasteImage,
	running,
	locked,
}: ComposerProps): JSX.Element {
	const { stdin, setRawMode } = useStdin();

	const bufRef = useRef(new TextBuffer());
	const parserRef = useRef<InputParser | null>(null);
	const [, setVersion] = useState(0);
	const [pendingPastes, setPendingPastes] = useState<PendingPaste[]>([]);
	const [paletteIdx, setPaletteIdx] = useState(0);
	const [exitHint, setExitHint] = useState(false);
	const [imageNotice, setImageNotice] = useState<string | null>(null);

	// Paste state as refs — persists across renders, no useState needed
	const pasteRef = useRef({ active: false, buffer: "" });

	const pendingPastesRef = useRef(pendingPastes);
	pendingPastesRef.current = pendingPastes;
	const runningRef = useRef(running);
	runningRef.current = running;
	const onSubmitRef = useRef(onSubmit);
	onSubmitRef.current = onSubmit;
	const canSubmitRef = useRef(canSubmit);
	canSubmitRef.current = canSubmit;
	const onAbortRef = useRef(onAbort);
	onAbortRef.current = onAbort;
	const onExitRef = useRef(onExit);
	onExitRef.current = onExit;
	const onPasteImageRef = useRef(onPasteImage);
	onPasteImageRef.current = onPasteImage;
	const lastCtrlCRef = useRef(0);
	const lockedRef = useRef(locked);
	lockedRef.current = locked;
	const paletteScrollRef = useRef(0);

	const buf = bufRef.current;
	const val = buf.value;
	// A pasted absolute file path (e.g. from image attachment) also starts with
	// "/" and has no spaces or newlines — indistinguishable from a slash command
	// in progress by those checks alone. Real command names never contain a
	// second "/", so requiring that rules out paths without needing a
	// filesystem check.
	const paletteOpen = val.startsWith("/") && !val.includes("\n") && !val.includes(" ") && !val.slice(1).includes("/");
	const filteredCmds = useMemo(
		() => (paletteOpen ? SLASH_COMMANDS.filter((c) => c.name.startsWith(val)) : []),
		[paletteOpen, val],
	);
	const safeIdx = paletteOpen ? Math.min(paletteIdx, Math.max(0, filteredCmds.length - 1)) : 0;

	// Scroll the PALETTE_ROWS-tall window to keep safeIdx in view — a plain
	// `slice(0, PALETTE_ROWS)` only ever showed the first page, so pressing
	// Down past row 8 moved the selection off-screen with no visual sign of it.
	if (paletteOpen) {
		const maxOffset = Math.max(0, filteredCmds.length - PALETTE_ROWS);
		if (safeIdx < paletteScrollRef.current) paletteScrollRef.current = safeIdx;
		else if (safeIdx >= paletteScrollRef.current + PALETTE_ROWS)
			paletteScrollRef.current = safeIdx - PALETTE_ROWS + 1;
		paletteScrollRef.current = Math.min(paletteScrollRef.current, maxOffset);
	} else {
		paletteScrollRef.current = 0;
	}
	const paletteScroll = paletteScrollRef.current;

	useEffect(() => {
		if (paletteIdx > 0 && paletteIdx >= filteredCmds.length) setPaletteIdx(0);
	}, [paletteIdx, filteredCmds.length]);

	const doSubmit = () => {
		const b = bufRef.current;
		if (b.length === 0) return;
		// Expand paste chips back to the real text. Sequential first-occurrence
		// replace (not a global regex swap) so two chips with the same line
		// count each get their own text instead of both becoming the first one's.
		let value = b.value;
		for (const paste of pendingPastesRef.current) {
			value = value.replace(paste.placeholder, paste.text);
		}
		// Ask the parent whether this submission should go through — if not
		// (e.g. plain text while the agent is running), keep the buffer intact
		// so the user can edit and retry without retyping.
		if (canSubmitRef.current && !canSubmitRef.current(value)) return;
		onSubmitRef.current(value);
		b.clear();
		setPendingPastes([]);
	};

	const handleCtrlC = () => {
		if (runningRef.current) {
			onAbortRef.current();
			return;
		}
		const now = Date.now();
		if (now - lastCtrlCRef.current < 2000) {
			onExitRef.current();
			return;
		}
		lastCtrlCRef.current = now;
		setExitHint(true);
		setTimeout(() => setExitHint(false), 2000);
	};

	const handleAttachImage = () => {
		const reader = onPasteImageRef.current;
		if (!reader) {
			setImageNotice("[Image paste not available]");
			setTimeout(() => setImageNotice(null), 3000);
			return;
		}
		setImageNotice("[Reading clipboard...]");
		void reader().then((filePath) => {
			if (filePath) {
				bufRef.current.insert(filePath);
				// Left showing (not auto-cleared like the other notices below) — it's
				// the only visible confirmation of which file got attached, and it
				// stays relevant for as long as that path sits in the composer.
				setImageNotice(`[Image saved: ${filePath}]`);
			} else {
				setImageNotice("[No image in clipboard — copy a screenshot or image file first]");
				setTimeout(() => setImageNotice(null), 4000);
			}
			setVersion((v) => v + 1);
		});
	};

	const selectCommand = () => {
		const cmd = filteredCmds[safeIdx];
		if (!cmd) return;
		bufRef.current.clear();
		bufRef.current.insert(`${cmd.name} `);
		setPaletteIdx(0);
	};

	const handleEventRef = useRef<(event: InputEvent) => void>(() => {});
	handleEventRef.current = (event: InputEvent) => {
		const b = bufRef.current;

		if (paletteOpen) {
			if (event.type === "binding") {
				if (event.binding === "editor.cursorUp") {
					setPaletteIdx((i) => (i - 1 + filteredCmds.length) % Math.max(1, filteredCmds.length));
					return;
				}
				if (event.binding === "editor.cursorDown") {
					setPaletteIdx((i) => (i + 1) % Math.max(1, filteredCmds.length));
					return;
				}
				if (event.binding === "input.submit" || event.binding === "input.tab") {
					selectCommand();
					return;
				}
				if (event.binding === "input.escape") {
					setPaletteIdx(0);
					return;
				}
			}
		} else {
			if (event.type === "binding" && event.binding === "input.escape") {
				b.clear();
				return;
			}
		}

		if (event.type === "binding") {
			switch (event.binding) {
				case "input.submit":
					doSubmit();
					break;
				case "input.newLine":
					b.insertNewline();
					break;
				case "input.abort":
					handleCtrlC();
					break;
				case "input.attachImage":
					handleAttachImage();
					break;
				case "input.tab":
					break;
				case "editor.cursorUp":
					b.moveUp();
					break;
				case "editor.cursorDown":
					b.moveDown();
					break;
				case "editor.cursorLeft":
					b.moveLeft();
					break;
				case "editor.cursorRight":
					b.moveRight();
					break;
				case "editor.cursorWordLeft":
					b.moveWordLeft();
					break;
				case "editor.cursorWordRight":
					b.moveWordRight();
					break;
				case "editor.cursorLineStart":
					b.moveLineStart();
					break;
				case "editor.cursorLineEnd":
					b.moveLineEnd();
					break;
				case "editor.deleteCharBackward":
					b.backspace();
					break;
				case "editor.deleteCharForward":
					b.deleteForward();
					break;
				case "editor.deleteWordBackward":
					b.deleteWordBackward();
					break;
				case "editor.deleteWordForward":
					b.deleteWordForward();
					break;
				case "editor.deleteToLineStart":
					b.deleteToLineStart();
					break;
				case "editor.deleteToLineEnd":
					b.deleteToLineEnd();
					break;
				case "input.escape":
					break;
			}
			return;
		}

		if (event.type === "char") {
			b.insert(event.text);
		}
	};

	useEffect(() => {
		setRawMode(true);
		// Write escape sequences to stderr — process.stdout is owned by Ink's
		// renderer and may buffer/rewrite our sequences. stderr is uncontrolled
		// by Ink and reaches the terminal immediately.
		const esc = process.stderr;
		esc.write(BRACKETED_PASTE_ON);
		esc.write(KITTY_PUSH);

		const onCont = () => {
			esc.write(BRACKETED_PASTE_ON);
			esc.write(KITTY_PUSH);
		};
		process.on("SIGCONT", onCont);

		const parser = new InputParser((event: InputEvent) => handleEventRef.current(event));
		parserRef.current = parser;

		// Paste state for bracketed paste accumulation
		const stdinSource = stdin ?? process.stdin;
		const stdinDataHandler = (chunk: Buffer) => {
			if (lockedRef.current) return;

			const data = chunk.toString("utf-8");

			// Bracketed paste: accumulate until end marker
			if (pasteRef.current.active) {
				pasteRef.current.buffer += data;
				const endIdx = pasteRef.current.buffer.indexOf("\x1b[201~");
				if (endIdx !== -1) {
					const content = pasteRef.current.buffer.slice(0, endIdx);
					pasteRef.current.active = false;
					pasteRef.current.buffer = "";
					handlePasteContent(content);
					const remaining = pasteRef.current.buffer.slice(endIdx + 6);
					if (remaining) handlePlainOrStartPaste(remaining);
				}
				return;
			}

			handlePlainOrStartPaste(data);
		};

		const handlePlainOrStartPaste = (data: string) => {
			// Bracketed paste start
			const startIdx = data.indexOf("\x1b[200~");
			if (startIdx !== -1) {
				const before = data.slice(0, startIdx);
				if (before) handlePlainInput(before);
				pasteRef.current.buffer = data.slice(startIdx + 6);
				pasteRef.current.active = true;
				const endIdx = pasteRef.current.buffer.indexOf("\x1b[201~");
				if (endIdx !== -1) {
					const content = pasteRef.current.buffer.slice(0, endIdx);
					pasteRef.current.active = false;
					const remaining = pasteRef.current.buffer.slice(endIdx + 6);
					pasteRef.current.buffer = "";
					handlePasteContent(content);
					if (remaining) handlePlainOrStartPaste(remaining);
				}
				return;
			}
			handlePlainInput(data);
		};

		const handlePasteContent = (raw: string) => {
			// Normalize line endings (like opencode)
			const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
			if (!text) return;
			const lineCount = text.split("\n").length;
			const totalChars = text.length;
			// Match opencode: compress if > 10 lines or > 1000 chars
			if (lineCount > 10 || totalChars > 1000) {
				const label = lineCount > 10 ? `+${lineCount} lines` : `${totalChars} chars`;
				const placeholder = `[Pasted ${label}]`;
				setPendingPastes((p) => [...p, { placeholder, text }]);
				bufRef.current.insert(placeholder);
			} else {
				bufRef.current.insert(text);
			}
			setVersion((v) => v + 1);
		};

		const handlePlainInput = (data: string) => {
			// In raw mode each keypress arrives as a single character.
			// A multi-character chunk with line breaks is a paste without
			// bracketed markers (e.g. Cursor, VS Code terminals).
			if (data.length > 1 && (data.includes("\n") || data.includes("\r"))) {
				handlePasteContent(data);
				return;
			}
			parser.feed(Buffer.from(data, "utf-8"));
			setVersion((v) => v + 1);
		};

		stdinSource.on("data", stdinDataHandler);

		return () => {
			setRawMode(false);
			esc.write(KITTY_POP);
			esc.write(BRACKETED_PASTE_OFF);
			process.off("SIGCONT", onCont);
			stdinSource.off("data", stdinDataHandler);
			parser.destroy();
		};
	}, [setRawMode, stdin]);

	const { lines, cursorLine, cursorCol } = buf.getLayout();
	const visibleLines = lines.length > 5 ? lines.slice(-5) : lines;
	const offset = Math.max(0, lines.length - visibleLines.length);

	return (
		<Box flexDirection="column">
			{imageNotice && <Text color="green">{imageNotice}</Text>}
			{paletteOpen && filteredCmds.length > 0 && (
				<Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
					{/* Always PALETTE_ROWS slots, padded with blank lines, and each row
					    force-truncated to one line: the box's height must stay constant
					    as the filter narrows while typing, or the input frame below it
					    jumps up and down every keystroke. */}
					{Array.from({ length: PALETTE_ROWS }, (_, i) => {
						const c = filteredCmds[paletteScroll + i];
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed-size slot grid, not a reorderable list
						if (!c) return <Text key={`empty-${i}`}> </Text>;
						const selected = paletteScroll + i === safeIdx;
						return (
							<Text key={c.name} color={selected ? "green" : "gray"} wrap="truncate">
								{selected ? "> " : "  "}
								<Text bold={selected}>{c.name}</Text> <Text color="gray">{c.description}</Text>
							</Text>
						);
					})}
					<Text color="gray">
						↑↓ · Tab/Enter · Esc
						{filteredCmds.length > PALETTE_ROWS ? ` · ${safeIdx + 1}/${filteredCmds.length}` : ""}
					</Text>
				</Box>
			)}
			{exitHint && (
				<Box>
					<Text color="yellow">[Press Ctrl+C again to exit]</Text>
				</Box>
			)}
			<Box
				flexDirection="column"
				borderStyle="round"
				borderColor={locked ? "gray" : running ? "yellow" : BORDER_COLOR_ACTIVE}
				paddingX={1}
			>
				{visibleLines.map((line, i) => {
					const realLine = i + offset;
					const isCursorLine = realLine === cursorLine;
					const beforeCol = isCursorLine ? line.slice(0, cursorCol) : line;
					const atCol = isCursorLine ? line.slice(cursorCol, cursorCol + 1) : "";
					const afterCol = isCursorLine ? line.slice(cursorCol + (atCol ? 1 : 0)) : "";
					return (
						<Text key={realLine}>
							<Text color={PROMPT_COLOR} bold>
								{realLine === 0 ? "> " : "  "}
							</Text>
							{renderWithPasteChips(beforeCol, `${realLine}-before`)}
							{isCursorLine && (
								<Text color="white" inverse>
									{atCol || " "}
								</Text>
							)}
							{renderWithPasteChips(afterCol, `${realLine}-after`)}
						</Text>
					);
				})}
				{lines.length === 0 && (
					<Text>
						<Text color={PROMPT_COLOR} bold>
							{"> "}
						</Text>
						<Text color="gray">
							{running
								? "/queue to queue, /steer to inject..."
								: "type / for commands, Shift+Enter for newline, Ctrl+G to attach image"}
						</Text>
					</Text>
				)}
			</Box>
		</Box>
	);
}
