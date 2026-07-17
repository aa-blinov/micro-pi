---
name: cast
label: cast
description: Configure cast itself — personas, skills, marketplace plugins, MCP servers, or rules. Use when the user wants to customize cast or install plugins from Codex/Claude/Grok catalogs.
---

# cast configuration

cast stores user config under `~/.cast/` (global) and `<cwd>/.cast/` (project-local).

- Slash toggles/install/uninstall for `/skills`, `/mcp`, `/plugin`: hot-reload in the same session — no `/reload`, no restart.
- File drops/edits (skills, personas, rules, mcp.json, `npx skills add`): `/reload` in the same session (does not reset chat).

## Personas

Personas are system prompts that give the agent a different role. Active persona's full body becomes the system prompt.

**Locations** (highest priority first):

1. `.cast/personas/*.md` — project (trust-gated)
2. `~/.cast/personas/*.md` — global
3. Shipped with cast — builtin

**File format** — frontmatter + markdown body:

```markdown
---
name: my-persona
label: My Persona
description: Short description shown in the picker.
subagents: false
tools: [read, grep, ls, plan_*, web_*]
agentsMd: true
---

You are a specialized assistant that...

(Your full system prompt instructions here.)
```

**Rules:**

- `name` must be non-empty (used to select persona via `--persona <name>`)
- `label` is shown in `/persona` picker and `/personas` list; defaults to `name` if omitted
- `description` is shown in the picker
- `subagents: true` enables the `task` tool (default `false`)
- `tools` — optional allowlist of **built-in** tools (exact names or `*`-globs like `plan_*` / `web_*`). Omit = all builtins. MCP tools are never filtered by this list
- `agentsMd` — inject `AGENTS.md` / `CLAUDE.md` (default `true`; set `false` to skip)
- The body (after frontmatter) becomes the system prompt — `## Error Handling` section is appended automatically
- On name collision, project > global > builtin

**Example — create a persona:**

```bash
mkdir -p ~/.cast/personas
cat > ~/.cast/personas/analyst.md << 'EOF'
---
name: analyst
label: Data Analyst
description: Specialized in data analysis, SQL, and visualization.
---

You are an experienced data analyst operating inside a coding agent harness. You help the user explore data, write queries, and build visualizations — turning raw numbers into clear, actionable insights.

## Tools

You have the same tools as a coding agent, repurposed for data work:

- **read**: Inspect data files, SQL scripts, CSVs, and notebooks before drawing conclusions — never assume what the data looks like.
- **bash**: Run queries (sqlite3, psql, mysql), execute Python/R scripts, generate charts with matplotlib or ggplot.
- **grep**: Search logs, SQL files, and existing analyses for patterns, column names, or prior queries.
- **glob**: Locate data files, existing reports, or dashboards by name.
- **write**: Draft new SQL scripts, analysis notebooks, or report summaries.
- **edit**: Refine existing queries, fix broken joins, update WHERE clauses.
- **ls**: Survey what data files and existing analyses are available.

## Working style

- Always inspect the data (schema, sample rows, row counts) before writing queries — never guess column names or types.
- Explain your reasoning step by step: what you're querying, why that filter or join makes sense, what the result means.
- Suggest optimizations when queries are slow (indexes, EXPLAIN plans, denormalization).
- Present results in a clear format: tables for data, bullet points for takeaways, charts when trends matter.
- If the data is ambiguous or incomplete, say so — don't fill gaps with assumptions.
EOF
```

## Skills

Skills are reusable instruction files the model can read on demand.

**Locations** (highest priority first — on name collision, first-loaded wins):

1. `.cast/skills/` — project (trust-gated)
2. `.agents/skills/` — skills.sh universal project path (trust-gated)
3. `~/.cast/skills/` — global
4. `~/.config/agents/skills/` / `~/.agents/skills/` — skills.sh universal global
5. Enabled marketplace plugins (`/plugin install`) — `source: plugin`
6. Shipped with cast — builtin
7. `--skill <path>` — extra CLI paths (still load with `--no-skills`)

`--no-skills` skips project, agents, global, plugin, and builtin discovery.

`npx skills add owner/repo --skill name -a universal` → `.agents/skills/`; invoke with `/skill:name`.

**File format** — a directory with `SKILL.md`:

```
.cast/skills/my-skill/SKILL.md
```

```markdown
---
name: my-skill
description: What this skill does. Shown to the model in the available skills list.
disable-model-invocation: true
---

# My Skill

Instructions the model reads when this skill is invoked...

(Relative paths inside the skill directory resolve against it.)
```

**Rules:**

- `name` must be lowercase, alphanumeric + hyphens
- `description` is required (shown to the model)
- `disable-model-invocation: true` — skill is hidden from model, only usable via `/skill:name`
- `/skills` — multi-select toggle; also `list`, `enable`/`disable <name>`, `uninstall`, `help`
- `/skills uninstall` — delete cast/agents skill from disk (picker or name + confirm); plugin skills show locked → `/plugin uninstall`
- Plugin skills are labeled `plugin · name@marketplace`; if the pack is off, they stay visible but locked until `/plugin` re-enables the pack
- On name collision: `.cast` project > `.agents` project > `.cast` global > `.agents` global > plugin > builtin

**Example — create a skill:**

```bash
mkdir -p ~/.cast/skills/git-workflow
cat > ~/.cast/skills/git-workflow/SKILL.md << 'EOF'
---
name: git-workflow
description: Branch naming, commit messages, and PR conventions for this repo.
---

# Git Workflow

- Branch naming: `feat/<ticket>-<short-desc>`, `fix/<ticket>-<short-desc>`
- Commit format: `<type>(<scope>): <summary>`
- Always squash-merge PRs
EOF
```

## Marketplace plugins

Plugins are installable packs (usually skills) from catalogs — same `name@marketplace` shape as Claude Code / Grok Build. MVP loads **skills** from plugins only (not MCP/hooks inside the pack).

**Defaults** (seeded once on first `/plugin` / marketplace / install):

| Label | Source repo | Typical marketplace name |
|-------|-------------|--------------------------|
| Codex | `openai/plugins` | `openai-curated` |
| Claude | `anthropics/claude-plugins-official` | `claude-plugins-official` |
| Grok | `xai-org/plugin-marketplace` | `xai-official` |

**Commands** — type `/plugin` in the composer; the palette lists every subcommand:

```
/plugin                              # toggle installed plugins
/plugin list
/plugin marketplace list             # catalogs
/plugin marketplace list xai-official
/plugin install superpowers@xai-official
/plugin uninstall                    # picker + confirm
/plugin enable|disable NAME@SHOP
/skills list                         # catalog after install
/skills                              # toggle
```

Install hot-reloads the skill catalog. Prefer plugins that ship a `skills/` directory (packs with only `commands/` / `agents/` contribute nothing in cast yet). Disabling a pack via `/plugin` locks its skills in `/skills` (muted) until the pack is on again.

Layout: `~/.cast/plugins/` (marketplaces, installs, `known_marketplaces.json`). State: `enabledPlugins` in `settings.json`.

## MCP Servers

MCP (Model Context Protocol) servers provide external tools.

**Locations** (on name collision, last-loaded wins — reverse of skills/personas):

1. `~/.cast/mcp.json` — global
2. `.cast/mcp.json` — project (trust-gated)
3. `--mcp <path>` — extra CLI paths (loaded last, highest priority)

Global servers load first, project and CLI override them on name collision.

**File format** — common `mcpServers` JSON shape:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["path/to/server.js"],
      "env": { "API_KEY": "..." },
      "cwd": "/optional/working/dir"
    },
    "remote-server": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

**Transports:** stdio (local process — `command`+`args`+`env`+`cwd`) and streamable HTTP (remote — `url`+`headers`, static-header auth only, no OAuth).

**Tool names** are namespaced as `mcp_<server>_<tool>` to avoid collisions.

Same command shape as skills: `/mcp` toggle, `list`, `enable`/`disable <name>`, `uninstall` (confirm), `help`. Disabled servers persist in `disabledMcpServers`. Only enabled servers appear in `<available_mcp>`.

`/mcp uninstall` removes a server from global or project `mcp.json`. CLI `--mcp` paths are not removable here.

## Rules

Cursor-compatible rule files (not a single `rules.md`):

1. `~/.cast/rules/*.md` — global
2. `.cast/rules/*.md` — project (trust-gated)

Frontmatter: `always-apply`, `globs`, `description` (lazy), or manual via `/rule:name`. See docs/rules.md.

**Commands:** `/rules` (list), `/rule:<name>` (force-load).

**Example:**

```bash
mkdir -p .cast/rules
cat > .cast/rules/typescript.md << 'EOF'
---
always-apply: false
globs: ["*.ts", "*.tsx"]
---

Use strict TypeScript; prefer unknown over any.
EOF
```

Then `/reload`.

## Applying Changes

Never quit cast for these — the chat continues either way.

| Change | How to apply |
|--------|----------------|
| `/skills` / `/mcp` / `/plugin` toggle, enable/disable, uninstall | automatic (hot-reload) |
| `/plugin install` / marketplace remove | automatic (skills reload) |
| New/edited files under `.cast/` / `~/.cast/` / `.agents/` (skills, personas, rules, mcp.json) | `/reload` (same session) |
