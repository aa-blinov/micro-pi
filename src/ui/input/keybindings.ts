import { type KeyId, matchesKey } from "./keys.ts";

export interface KeybindingDefinition {
	defaultKeys: KeyId | KeyId[];
	description?: string;
}

export type KeybindingDefinitions = Record<string, KeybindingDefinition>;
export type KeybindingsConfig = Record<string, KeyId | KeyId[] | undefined>;

export const TUI_KEYBINDINGS = {
	"editor.cursorUp": { defaultKeys: "up" },
	"editor.cursorDown": { defaultKeys: "down" },
	"editor.cursorLeft": { defaultKeys: ["left", "ctrl+b"] },
	"editor.cursorRight": { defaultKeys: ["right", "ctrl+f"] },
	"editor.cursorWordLeft": { defaultKeys: ["alt+left", "ctrl+left", "alt+b"] },
	"editor.cursorWordRight": { defaultKeys: ["alt+right", "ctrl+right", "alt+f"] },
	"editor.cursorLineStart": { defaultKeys: ["home", "ctrl+a"] },
	"editor.cursorLineEnd": { defaultKeys: ["end", "ctrl+e"] },
	"editor.deleteCharBackward": { defaultKeys: "backspace" },
	"editor.deleteCharForward": { defaultKeys: ["delete", "ctrl+d"] },
	"editor.deleteWordBackward": { defaultKeys: ["ctrl+w", "alt+backspace"] },
	"editor.deleteWordForward": { defaultKeys: ["alt+d", "alt+delete"] },
	"editor.deleteToLineStart": { defaultKeys: "ctrl+u" },
	"editor.deleteToLineEnd": { defaultKeys: "ctrl+k" },
	"input.newLine": { defaultKeys: ["shift+enter", "ctrl+j", "alt+enter"] },
	"input.submit": { defaultKeys: "enter" },
	"input.abort": { defaultKeys: "ctrl+c" },
	"input.escape": { defaultKeys: "escape" },
	"input.attachImage": { defaultKeys: "ctrl+g" },
	"input.tab": { defaultKeys: "tab" },
} as const satisfies KeybindingDefinitions;

export type Keybinding = keyof typeof TUI_KEYBINDINGS;

export class KeybindingsManager {
	private keysById = new Map<Keybinding, KeyId[]>();

	constructor(userBindings: KeybindingsConfig = {}) {
		for (const [id, definition] of Object.entries(TUI_KEYBINDINGS)) {
			const userKeys = userBindings[id];
			const keys =
				userKeys === undefined
					? Array.isArray(definition.defaultKeys)
						? definition.defaultKeys
						: [definition.defaultKeys]
					: Array.isArray(userKeys)
						? userKeys
						: [userKeys];
			this.keysById.set(id as Keybinding, keys);
		}
	}

	matches(data: string, keybinding: Keybinding): boolean {
		const keys = this.keysById.get(keybinding) ?? [];
		for (const key of keys) {
			if (matchesKey(data, key)) return true;
		}
		return false;
	}
}

let globalKeybindings: KeybindingsManager | null = null;

export function getKeybindings(): KeybindingsManager {
	if (!globalKeybindings) globalKeybindings = new KeybindingsManager();
	return globalKeybindings;
}
