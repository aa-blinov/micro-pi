/**
 * Minimal frontmatter parser shared by skills.ts and personas.ts — flat
 * scalars only, not full YAML. Every field either module actually reads
 * (name, description, label, disable-model-invocation, ...) is a simple
 * scalar in practice, so pulling in a YAML dependency isn't worth it.
 */

export interface ParsedFrontmatter {
	frontmatter: Record<string, string | boolean>;
	body: string;
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---")) return { frontmatter: {}, body: normalized };

	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return { frontmatter: {}, body: normalized };

	const yamlBlock = normalized.slice(3, end).trim();
	const body = normalized.slice(end + 4).replace(/^\n/, "");

	const frontmatter: Record<string, string | boolean> = {};
	for (const line of yamlBlock.split("\n")) {
		const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
		if (!match) continue;
		const key = match[1]!;
		let value = match[2]!.trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		frontmatter[key] = value === "true" ? true : value === "false" ? false : value;
	}

	return { frontmatter, body };
}
