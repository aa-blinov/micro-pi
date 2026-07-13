# cast Documentation

A terminal coding agent that works with **any** OpenAI-compatible API. Point it at OpenRouter, OpenAI, Ollama, vLLM, LiteLLM, or your own inference server.

**No vendor lock-in.** Swap providers and models without touching your workflow. One config file, one API key, works everywhere.

**Real tools, real work.** Reads files, writes code, runs shell commands, searches your codebase — all in parallel. Delegates sub-tasks to isolated sub-agents.

**Extensible.** Rules, skills, MCP servers, and personas — add capabilities without touching the codebase.

## Table of Contents

| Guide | What it covers |
|-------|----------------|
| [Getting Started](getting-started.md) | Install, first run, provider setup |
| [CLI Reference](cli-reference.md) | All flags and subcommands |
| [Interactive Commands](interactive-commands.md) | All `/slash` commands in the TUI |
| [Tools](tools.md) | Built-in tools the agent uses |
| [Personas](personas.md) | Built-in personas and creating custom ones |
| [Skills](skills.md) | Agent Skills spec, loading, creating |
| [Rules](rules.md) | Cursor-compatible rule system |
| [MCP Servers](mcp-servers.md) | MCP configuration (local and remote) |
| [Context Files](context-files.md) | AGENTS.md / CLAUDE.md hierarchy |
| [Sessions](sessions.md) | Persistence, resume, compaction |
| [Plan Mode](plan-mode.md) | Explore and plan before implementing |
| [Reasoning](reasoning.md) | Reasoning levels and provider support |
| [Configuration](configuration.md) | settings.json, env vars, .cast/ layout |
| [Themes](themes.md) | Color themes |
| [Non-Interactive Mode](non-interactive-mode.md) | `cast run` and JSON output |
| [Architecture](architecture.md) | Source layout and design decisions |
| [Changelog](changelog.md) | Version history and feature highlights |
