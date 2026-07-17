---
name: cast
label: cast
description: Configure cast itself — add personas, skills, MCP servers, or rules. Use when the user wants to customize cast's behavior or add new capabilities.
---

# cast configuration

cast stores all user configuration under `~/.cast/` (global) and `<cwd>/.cast/` (project-local). After any change, run `/reload` to apply without restarting.

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
2. `~/.cast/skills/` — global
3. Shipped with cast — builtin
4. `--skill <path>` — extra CLI paths (loaded last)

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
- On name collision, project > global > builtin

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

Servers listed in mcp.json can be toggled on/off per-session via `/mcp` — disabled servers are hidden from the model and persisted in settings. Only enabled servers appear in `<available_mcp>`.

## Rules

Rules are short instructions appended to the system prompt.

**Locations** (both are concatenated, not priority-based):

1. `~/.cast/rules.md` — global (always loaded)
2. `.cast/rules.md` — project (trust-gated, appended after global)

**Managed via commands:**

- `/rules` — list all rules
- `/rules add <text>` — add a rule (auto-numbered)
- `/rules delete <number>` — remove a rule by number

**Example:**

```
/rules add Always respond in Spanish
/rules add Prefer functional style over classes
/rules delete 2
```

## Applying Changes

After creating or modifying any of the above, run:

```
/reload
```

This re-scans skills, personas, and reconnects MCP servers for the current directory without restarting.
