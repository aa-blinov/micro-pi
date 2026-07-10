/**
 * Bash safety gate — a curated denylist of destructive/high-blast-radius
 * command patterns. Not exhaustive (no static check can be); it just catches
 * the obvious foot-guns. Everything else runs without asking, and write/edit
 * are never gated — only bash, per an explicit product decision (the file
 * tools are trivially reversible via git; an arbitrary shell command isn't).
 */

interface DangerPattern {
	regex: RegExp;
	reason: string;
}

/**
 * Matches `word` only where a shell would actually treat it as a command
 * name (start of the string, or right after `;`, `&&`, `||`, `|`, or `(`) —
 * not word-boundary-anywhere, which would also match e.g. "sudo" inside
 * "hi-from-sudo" (hyphens count as word boundaries too).
 */
function commandStart(word: string): RegExp {
	return new RegExp(`(^|[;&|(]\\s*)${word}\\b`);
}

const DANGEROUS_PATTERNS: DangerPattern[] = [
	{ regex: /\brm\s+(-\w*[rf]\w*[rf]?\w*|--recursive|--force)\b/, reason: "recursive/force delete (rm -rf)" },
	{ regex: commandStart("sudo"), reason: "elevated privileges (sudo)" },
	{ regex: /\bgit\s+push\b[^|;&\n]*(--force(?!-)\b|-f\b)/, reason: "force push (rewrites remote history)" },
	{ regex: /\bgit\s+reset\s+--hard\b/, reason: "git reset --hard (discards local changes)" },
	{ regex: /\bgit\s+clean\s+-\w*[df]\w*[df]?\w*/, reason: "git clean -fd (deletes untracked files)" },
	{
		regex: /\b(curl|wget)\b[^|;\n]*\|\s*(sudo\s+)?(bash|sh|zsh)\b/,
		reason: "piping a remote script straight into a shell",
	},
	{ regex: /\bchmod\s+(-R\s+)?0?777\b/, reason: "chmod 777 (world-writable permissions)" },
	{ regex: commandStart("mkfs(\\.\\w+)?"), reason: "formatting a filesystem (mkfs)" },
	{ regex: /\bdd\s+if=/, reason: "raw disk write (dd)" },
	{ regex: />\s*\/dev\/(sd|nvme|disk|hd)/, reason: "writing directly to a block device" },
	{ regex: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
	{ regex: commandStart("(shutdown|reboot|poweroff|halt)"), reason: "shutting down or rebooting the machine" },
	{ regex: /\bnpm\s+publish\b/, reason: "publishing a package publicly" },
	{ regex: commandStart("killall"), reason: "killing every process on the machine" },
	{ regex: /\bkill\s+-9\s+-?1\b/, reason: "killing every process on the machine" },
	{ regex: /\bgit\s+(checkout|restore)\s+\.(?!\w)/, reason: "discarding all uncommitted changes" },
	{ regex: /\brsync\b[^|;&\n]*--delete/, reason: "rsync --delete (removes files not in source)" },
	{ regex: /\bfind\b[^|;&\n]*-delete/, reason: "find -delete (mass file deletion)" },
	{ regex: /\bxargs\b[^|;&\n]*\brm\b/, reason: "xargs rm (mass deletion via pipe)" },
	{ regex: commandStart("pkill"), reason: "killing processes by name" },
	{ regex: /\bcrontab\s+-r\b/, reason: "removing all cron jobs" },
	{ regex: /\biptables\s+-F\b/, reason: "flushing all firewall rules" },
	{
		regex: /\bb?base64\b[^|;&\n]*-d[^|;&\n]*\|\s*(sudo\s+)?(bash|sh|zsh)\b/,
		reason: "decoding and piping into a shell (obfuscated code execution)",
	},
];

/** Returns a human-readable reason if `command` matches a known-dangerous pattern, else undefined. */
export function checkDangerousBash(command: string): string | undefined {
	for (const { regex, reason } of DANGEROUS_PATTERNS) {
		if (regex.test(command)) return reason;
	}
	return undefined;
}
