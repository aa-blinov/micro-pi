import { ask, type createRl } from "../core/readline.ts";
import type { Pickers, PickOption, PickOptions } from "./types.ts";

/**
 * Readline-backed Pickers implementation for the `--basic` UI. The classic
 * numbered-list style is preserved so existing users on `--basic` see the
 * exact same prompts as before — the only change is that the per-prompt
 * formatting now lives here instead of inside each domain function.
 */
export function createReadlinePickers(rl: ReturnType<typeof createRl>): Pickers {
	return {
		async pickOption<T>(options: PickOption<T>[], opts?: PickOptions): Promise<T | null> {
			const title = opts?.title;
			if (title) console.log(`\n${title}:`);
			else console.log("");
			for (let i = 0; i < options.length; i++) {
				const o = options[i]!;
				const isDefault = i === (opts?.defaultIndex ?? -1);
				const marker = isDefault ? " (default)" : "";
				console.log(`  ${i + 1}. ${o.label}${marker}`);
			}
			console.log(`\nEnter number (1-${options.length}), name, or press Enter to cancel\n`);
			while (true) {
				const input = await ask(rl, "Select: ");
				const trimmed = input.trim();
				if (trimmed === "/quit" || trimmed === "/exit") process.exit(0);
				if (!trimmed) return null;
				const num = Number.parseInt(trimmed, 10);
				if (!Number.isNaN(num) && num >= 1 && num <= options.length) return options[num - 1]!.value;
				const byLabel = options.find((o) => o.label === trimmed || o.label.startsWith(trimmed));
				if (byLabel) return byLabel.value;
				console.log(`Enter a number (1-${options.length}) or a valid option name.`);
			}
		},

		async promptText(label: string, defaultValue?: string, placeholder?: string): Promise<string | null> {
			const ph = placeholder ? ` (${placeholder})` : "";
			const dv = defaultValue ? ` [${defaultValue}]` : "";
			const input = await ask(rl, `${label}${ph}${dv}: `);
			const trimmed = input.trim();
			if (trimmed === "/quit" || trimmed === "/exit") process.exit(0);
			return trimmed;
		},

		log(text: string): void {
			console.log(text);
		},
	};
}
