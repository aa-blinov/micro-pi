# Skills

Skills are self-contained instruction packages the agent loads on demand. They follow the [Agent Skills spec](https://agentskills.io) — a standard for packaging reusable agent capabilities.

## How Skills Work

The agent sees a list of available skills (name + description) in its system prompt. When a task matches a skill's description, the agent reads the skill file using the `read` tool to get full instructions. Skills with `disable-model-invocation: true` are hidden from the agent and can only be invoked manually via `/skill:<name>`.

## Built-in Skills

Skills ship with cast in `prompts/skills/`. Use `/skills list` to see what's loaded; bare `/skills` toggles them on/off.

## Loading Priority

Skills are discovered from multiple locations. On a name collision, the first-loaded skill wins:

1. **Project (cast)** — `.cast/skills/` (trust-gated)
2. **Project (agents)** — `.agents/skills/` (trust-gated; skills.sh / `npx skills add` universal path)
3. **Global (cast)** — `~/.cast/skills/` (always loaded)
4. **Global (agents)** — `~/.config/agents/skills/` then `~/.agents/skills/` (skills.sh universal global)
5. **Plugin** — skills from enabled `/plugin install name@marketplace` packages
6. **Builtin** — `prompts/skills/` (ships with cast)
7. **Extra paths** — `--skill <path>` flags (loaded even with `--no-skills`)

Use `--no-skills` to skip auto-discovery (including `.agents/skills`). Extra paths (`--skill`) still load.

### skills.sh / `npx skills add`

```bash
npx -y skills add mattpocock/skills --skill grill-me -a universal
```

Installs into `.agents/skills/` (project) or `~/.config/agents/skills/` (global). Cast loads those automatically after `/reload` (or on next start). Invoke with `/skill:grill-me` (not `/grill-me`).

## Creating a Skill

### Directory Structure

A skill is a directory containing a `SKILL.md` file:

```
~/.cast/skills/
  my-skill/
    SKILL.md          # Skill definition
    templates/        # Any supporting files
      example.md
```

Or a standalone `.md` file at the top level:

```
~/.cast/skills/
  my-skill.md
```

### SKILL.md Format

```markdown
---
name: my-skill
description: Does something useful for a specific task type
---

When invoked, follow these steps:

1. Read the relevant files
2. Analyze the situation
3. Apply the template from `templates/example.md`
4. Produce the output

Always check `templates/` for reference material.
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Identifier (defaults to parent directory name) |
| `description` | **Yes** | What the skill does — skills without a description are dropped |
| `disable-model-invocation` | No | `true` to hide from the agent (manual `/skill:<name>` only) |

### Name Rules

Per the Agent Skills spec:

- Lowercase letters, digits, and hyphens only (`[a-z0-9-]+`)
- Must not start or end with a hyphen
- Must not contain consecutive hyphens (`--`)
- Maximum 64 characters

Names that violate these rules generate a warning but still load.

### Relative Paths

When a skill file references relative paths (templates, examples, configs), resolve them against the skill's directory. The system prompt tells the agent: *"When a skill file references a relative path, resolve it against the skill directory."*

## Enabling / disabling

| Command | Description |
|---------|-------------|
| `/skills` | Toggle on/off (multi-select picker, like `/mcp`) |
| `/skills list` | Read-only catalog (source + on/off) |
| `/skills enable` / `disable <name>` | Toggle one skill without the picker |
| `/skills uninstall` | Remove a global/project skill (picker + confirm, or typed name) |
| `/skills help` | Cheat sheet |

Disabled names are stored in `~/.cast/settings.json` as `disabledSkills`. `/skill:<name>` only works for enabled skills.

Plugin skills show their pack id in the picker/list (`plugin · name@marketplace`). If the pack is disabled via `/plugin`, the skill stays visible but locked (muted, Space ignored) until you re-enable the pack — it is not added to `disabledSkills`.

`/skills uninstall` deletes a **global**, **project**, or **agents** (`.agents/skills`) skill from disk. Plugin skills appear in the picker muted/locked (Enter ignored) — remove the pack with `/plugin uninstall`. Builtin and `--skill` paths are omitted.

Whole marketplace packs can be toggled with bare `/plugin` (see [Plugins](plugins.md)).

### Hot-reload

`/skills` toggle / `enable` / `disable` / `uninstall` and `/plugin install` / enable / uninstall update the skill catalog **in the current session** — no `/reload`, no restart.

Use `/reload` only after dropping or editing skill files on disk yourself (e.g. `npx skills add`, copy into `.cast/skills/`). See [Interactive commands](interactive-commands.md#hot-reload-vs-reload).

## Invoking Skills

### Automatic

The agent reads a skill when the user's task matches its description. No special syntax needed.

### Manual

Force-load a skill by name:

```
/skill:arxiv search for papers about transformers
/skill:cast add a new persona
```

The `/skill:<name>` command reads the skill's full content and submits it to the agent as context, followed by any additional arguments.

## CLI Flags

| Flag | Description |
|------|-------------|
| `--skill <path>` | Load an extra skill file or directory (repeatable) |
| `--no-skills` | Skip project/agents/global/plugin/builtin skill discovery |

```bash
cast --skill ./my-project-skill.md
cast --no-skills --skill ~/.cast/skills/arxiv/SKILL.md
```

Extra paths (`--skill`) work even with `--no-skills` — they're explicit additions, not auto-discovery.

## Discovery Rules

The discovery algorithm for each directory:

1. If the directory contains `SKILL.md`, load it as a single skill and stop recursing.
2. Otherwise, load direct `.md` children as standalone skills, and recurse into subdirectories looking for `SKILL.md`.

Directories starting with `.` or named `node_modules` are always skipped.
