// ============================================================================
// Help
// ============================================================================

export const CAST_BANNER = [
	"                   __",
	"  _________ ______/ /_",
	" / ___/ __ `/ ___/ __/",
	"/ /__/ /_/ (__  ) /_  ",
	"\\___/\\__,_/____/\\__/  ",
].join("\n");

export function printHelp(): void {
	console.log(`
cast - Coding agent harness with swappable personas

Usage:
  cast [options] [prompt]
  cast run [options] <message>  Non-interactive mode (one prompt, stream to stdout, exit)
  cast upgrade [version] [--force]
                              Re-run the installer to update (release installs
                              only) — no-op if already on that version, unless
                              --force

TUI mode (Ink-based, multiline paste, image attachments, animations) is the
default. Non-TTY contexts (pipes, CI) are not supported — use an interactive
terminal.

Options:
  --version, -v              Show installed version
  --model, -m <model>        Model name (validated on startup)
  --reasoning, -r <level>    Reasoning level (off/low/medium/high/max)
                             Skips interactive selection. For local models
                             without /v1/models reasoning metadata.
  --continue, -c             Resume the most recently updated session
  --resume                   Pick which saved session to resume (numbered list)
  --resume=<id>              Resume a specific session by id (see /sessions)
  --session, -s <id>         Resume a specific session by id (alias for --resume=<id>)
  --persona, -p <name>       Persona to use (see /personas for the list)
                             Skips interactive selection.
  --bypass-permissions       Skip confirmation for dangerous bash commands
                             this run only — see /permissions to persist it
  --skill <path>             Load an extra skill file or directory
                             (repeatable, works even with --no-skills)
  --no-skills                Skip global/project skill discovery
  --mcp <path>               Load an extra MCP server config file
                             (repeatable, works even with --no-mcp)
  --no-mcp                   Skip global/project MCP server discovery
  --help, -h                 Show this help

Provider connection: saved settings > interactive prompt on first run.
Once entered, saved to ~/.cast/settings.json.

Skills (https://agentskills.io): self-contained instruction packages the
agent loads on demand, from ~/.cast/skills/ (global) and .cast/skills/
(project — asked to trust the project once, remembered after that).

MCP servers: Model Context Protocol servers, configured in ~/.cast/mcp.json
(global) and .cast/mcp.json (project — asked to trust once, remembered
after that), same "mcpServers" shape most MCP clients already use — local
{ "command", "args" } or remote { "url", "headers" } (static header/token
auth only, no OAuth). Their tools are added alongside the 7 built-in ones,
no special syntax needed to call them.

Personas: swappable system prompts for different roles (coding, sysadmin, ...)
— see prompts/personas/. Same tools either way; only the instructions change.

Interactive commands:
  /quit, /exit           Save and exit
  /clear                 Clear context (and save the cleared state)
  /compact               Compact context now (auto-triggers near the limit)
  /new                   Start a new session (autosaves current if non-empty)
  /model [name]          Show/change model (validated)
  /reasoning             Change reasoning level
  /provider              Change provider endpoint and API key (validated)
  /persona [name]        Show/change persona
  /personas              List available personas
  /sessions              List saved sessions, switch to one, or "d<N>" to delete
  /permissions           Show/change bash confirmation mode (default/bypass)
  /skills                List loaded skills
  /mcp                   List connected MCP servers and their tools
  /reload                Re-scan skills, personas, and reconnect MCP servers
                         for the current directory (no restart needed after
                         adding a skill, persona, or mcp.json entry)
  /skill:name [args]     Force-load and run a skill
  /usage                 Show cumulative token/cost usage for this session
  /context               Show current context size vs. the model's window
  /steer <message>       Inject message while agent is running
  /queue <message>       Queue message for after agent stops
  /queue-reset           Clear the message queue
  /abort, /stop          Abort current agent run
  /help                  Show help
`);
}
