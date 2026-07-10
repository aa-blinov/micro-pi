# cast

A terminal coding agent that works with **any** OpenAI-compatible API. Point it at OpenRouter, OpenAI, Ollama, vLLM, LiteLLM, or your own inference server — it doesn't care where the tokens come from.

```
                   __
  _________ ______/ /_
 / ___/ __ `/ ___/ __/
/ /__/ /_/ (__  ) /_
\___/\__,_/____/\__/
```

## Why cast?

**No vendor lock-in.** Swap providers and models without touching your workflow. One config file, one API key, works everywhere.

**Real tools, real work.** It reads files, writes code, runs shell commands, searches your codebase — and does it all in parallel. Delegates sub-tasks to isolated sub-agents. Not a chat wrapper with a "code interpreter" bolted on.

**Ink TUI.** A proper terminal interface with multiline paste, image attachments, smooth animations.

**Extensible.** Rules (per-project instructions in `.cast/rules.md`), skills (self-contained instruction packages), MCP servers (any Model Context Protocol tool server), and personas (swappable system prompts) — add capabilities without touching the codebase.

## Install

macOS / Linux:

```bash
curl -fsSL https://aa-blinov.github.io/cast/install | bash
```

Windows (PowerShell):

```powershell
irm https://aa-blinov.github.io/cast/install.ps1 | iex
```

Requires Node.js 18+. Self-contained bundle — no npm packages needed at runtime.

Pin a version: `CAST_VERSION=0.1.0 curl ... | bash`
Upgrade later: `cast upgrade`

## Quick Start

```bash
# Launch — prompts for provider URL + API key on first run, remembers after
cast

# One-shot prompt
cast "explain what this project does"

# Specific model + reasoning
cast -m qwen/qwen3-235b-a22b -r high "refactor this function"

# Resume last session
cast -c
```

## What it can do

### Built-in tools

`bash` `read` `write` `edit` `find` `grep` `ls` `task` `web_search` `web_fetch` — the agent has full filesystem, shell, and web access. Multiple tools run in parallel. The `task` tool delegates work to isolated sub-agents (with their own persona and context) and returns only the final result. Image files (jpg/png/gif/webp/bmp) are sent directly to vision-capable models. Web tools can be toggled on/off via `/web` (persists to settings).

### Rules

Project-specific instructions the agent always follows. п

### Project Context Files

Drop an `AGENTS.md` or `CLAUDE.md` in your repo root — cast picks it up automatically and injects it into the system prompt. Walks every ancestor directory up to `/`, so org-wide guidelines in a parent folder apply to all projects beneath it. The file in `cwd` itself is trust-gated; files above load without prompting. No special syntax, no config — just the file.

### Skills

Self-contained instruction packages loaded on demand from `~/.cast/skills/` (global) or `.cast/skills/` (project). Follows the [Agent Skills spec](https://agentskills.io). The agent sees what's available and loads the right one automatically.

### MCP Servers

Connect any [Model Context Protocol](https://modelcontextprotocol.io) server — local (stdio) or remote (streamable HTTP). Same `mcpServers` config shape as Claude Desktop / Cursor. Their tools appear alongside the built-in ones.

### Personas

Swap the agent's role without changing its tools:

| Persona | What it does |
|---------|-------------|
| `coding` (default) | Reads files, runs commands, edits code |
| `coder-with-subagents` | Delegates work to sub-agents via the `task` tool for parallel exploration |
| `writer` | Creative fiction, prose, literary craft |
| `pm` | Product strategy, specs, prioritization |
| `marketer` | Positioning, copy, go-to-market |
| `qa` | Functional testing — features, edge cases, regressions |
| `qa-nfr` | Non-functional — performance, security, reliability |

Add your own in `~/.cast/personas/` (global) or `.cast/personas/` (project).

### Context compaction

When the conversation gets too long, the agent automatically summarizes older messages — keeps the context window useful without losing important details.

### Reasoning levels

Models that support it (OpenRouter metadata) get reasoning controls: `off` / `low` / `medium` / `high` / `max`. Set via `--reasoning` or change mid-session with `/reasoning`.

### Sessions

Every conversation auto-saves. Resume with `--continue`, pick from a list with `--resume`, or switch mid-session with `/sessions`.

## Interactive Commands

| Command | Description |
|---------|-------------|
| Any text | Send a prompt to the agent |
| `/model [name]` | Show/change model |
| `/subagent-model [name]` | Show/change sub-agent model |
| `/reasoning` | Change reasoning level |
| `/persona [name]` | Show/change persona |
| `/personas` | List available personas |
| `/provider` | Change provider endpoint and API key |
| `/permissions [default\|bypass]` | Show/change bash confirmation mode |
| `/web` | Toggle web tools (web_search, web_fetch) |
| `/sessions` | List/switch/delete saved sessions |
| `/skills` | List loaded skills |
| `/skill:name [args]` | Force-load and run a skill |
| `/mcp` | List connected MCP servers and tools |
| `/reload` | Re-scan skills, rules, MCP, and personas for cwd |
| `/rules` | List loaded rules |
| `/rules add <text>` | Add a rule (picks local or global) |
| `/rules delete` | Delete a rule (interactive picker) |
| `/rule:name` | Invoke a rule by name |
| `/steer <msg>` | Inject message while agent is working |
| `/s <msg>` | Alias for `/steer` |
| `/queue <msg>` | Queue message for after agent stops |
| `/q <msg>` | Alias for `/queue` |
| `/queue-reset` | Clear the message queue |
| `/abort`, `/stop` | Stop current agent run |
| `/compact` | Force context compaction |
| `/new` | Start a new session (autosaves current) |
| `/copy` | Copy last assistant response to clipboard |
| `/clear` | Clear conversation context |
| `/usage` | Show token/cost usage |
| `/context` | Show context size vs. model window |
| `/theme` | Change color theme |
| `/repo` | Show cwd and git branch |
| `/quit`, `/exit` | Save and exit |
| `/keys` | List all keybindings |
| `/help` | Show this command list |

## CLI Options

```
cast [options] [prompt]
  cast run [options] <message>   Non-interactive mode (stream to stdout, exit)
  cast upgrade [version] [--force]
                                Re-run installer to update

Options:
  -m, --model <model>        Model name
  -r, --reasoning <level>    off / low / medium / high / max
  -p, --persona <name>       Persona to use
  -c, --continue             Resume most recent session
  --resume                   Pick which session to resume (numbered list)
  --resume=<id>              Resume specific session by id
  -s, --session <id>         Resume specific session (alias for --resume=<id>)
  --bypass-permissions       Skip dangerous-command confirmation
  --skill <path>             Load extra skill (repeatable)
  --no-skills                Skip global/project skill discovery
  --mcp <path>               Load extra MCP config (repeatable)
  --no-mcp                   Skip global/project MCP server discovery
  -v, --version              Show version
  -h, --help                 Show help

run subcommand:
  --format <default|json>    Output format
  (also accepts: -m, -r, -p, -c, -s, --bypass-permissions, --skill, --mcp)
```

## Provider Setup

On first run, cast asks for your provider URL and API key, then saves both to `~/.cast/settings.json`. No `.env` file needed.

Or set env vars:

| Variable | Description |
|----------|-------------|
| `PROVIDER_BASE_URL` | OpenAI-compatible endpoint URL |
| `PROVIDER_API_KEY` | API key |
| `CAST_CWD` | Override working directory |
| `CAST_VERSION` | Pin install version (installer) |

Works with anything that speaks the OpenAI API: OpenRouter, OpenAI, Ollama (`http://localhost:11434/v1`), vLLM, LiteLLM, Azure OpenAI, etc.

## Architecture

```
src/
  core/           Agent logic (no UI dependency)
    loop.ts         Agent loop — streaming, tool dispatch, compaction
    tools.ts        10 built-in tool definitions + executors
    llm.ts          LLM interaction, streaming, retry, prompt caching
    session.ts      Session persistence, token estimation, compaction
    mcp.ts          MCP server connection (stdio + streamable HTTP)
    personas.ts     Persona loading (project > global > builtin)
    rules.ts        Cursor-compatible rule system (always/auto/lazy/manual)
    skills.ts       Agent Skills spec implementation
    config.ts       AppConfig, model validation, onboarding
    project.ts      System prompt assembly, trust gating
    startup.ts      Unified startup orchestration
    runner.ts       Queue management (steering, follow-ups)
    run.ts          Non-interactive runner (cast run)
    vendors.ts      Reasoning metadata, think-block parsing
    upgrade.ts      Self-update via GitHub releases
    ...
  ui/             Ink TUI components
    App.tsx         Top-level layout
    Composer.tsx    Input with autocomplete, image paste
    ChatLog.tsx     Message rendering
    commands.ts     Slash command handlers
    ...
  pickers/        Onboarding pickers (model, persona, reasoning)
  index.ts        CLI entry point

prompts/          System prompts, persona files, compaction templates
test/             Vitest unit tests
scripts/          esbuild bundle step
dist/             Compiled single-file bundle
```

## Development

```bash
npm install --ignore-scripts
npm start               # Run from source (tsx)
npm run check           # Type check + lint (tsc + biome)
npm test                # Unit tests (vitest)
npm run build           # Bundle into dist/index.js (esbuild)
npm run format          # Auto-format (biome)
```

## License

[MIT](LICENSE)
