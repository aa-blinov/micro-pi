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
	{ regex: /\bgit\s+push\b[^|;&\n]*(--force\b|-f\b)/, reason: "force push (rewrites remote history)" },
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
];

/** Returns a human-readable reason if `command` matches a known-dangerous pattern, else undefined. */
export function checkDangerousBash(command: string): string | undefined {
	for (const { regex, reason } of DANGEROUS_PATTERNS) {
		if (regex.test(command)) return reason;
	}
	return undefined;
}

// ============================================================================
// Interactive command detection — commands that wait for user input.
// These are blocked because the agent can't interact with prompts.
// ============================================================================

const INTERACTIVE_PATTERNS: DangerPattern[] = [
	// Remote sessions
	{ regex: commandStart("ssh"), reason: "ssh opens an interactive session" },
	{ regex: commandStart("telnet"), reason: "telnet opens an interactive session" },
	// Text editors
	{ regex: commandStart("(vim|vi|nvim|nano|pico|emacs|code|subl)"), reason: "text editors require interactive input" },
	// Pagers
	{ regex: commandStart("(less|more|most)"), reason: "pagers require interactive input" },
	// Git commands that open an editor or prompt
	{
		regex: /\bgit\s+push\b(?!.*--no-edit)(?!.*-m\b)(?!.*--force-with-lease)/,
		reason: "git push may prompt for credentials",
	},
	{
		regex: /\bgit\s+commit\b(?!.*-m\b)(?!.*--message)(?!.*-F\b)(?!.*--file)(?!.*--no-edit)(?!.*--amend)/,
		reason: "git commit opens an editor",
	},
	{ regex: /\bgit\s+(rebase\s+-i|add\s+-p|stash\s+pop|checkout\s+-p)/, reason: "interactive git command" },
	// Shell read prompt
	{ regex: /\bread\s+(-[rsp]|--)/, reason: "read with prompt requires interactive input" },
	// Password/credential prompts
	{ regex: /\bpasswd\b/, reason: "passwd requires interactive input" },
];

/** Returns a reason if `command` is interactive and would hang waiting for input. */
export function checkInteractiveBash(command: string): string | undefined {
	for (const { regex, reason } of INTERACTIVE_PATTERNS) {
		if (regex.test(command)) return reason;
	}
	return undefined;
}
