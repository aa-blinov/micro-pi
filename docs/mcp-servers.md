# MCP Servers

cast supports [Model Context Protocol](https://modelcontextprotocol.io) servers — local (stdio) or remote (streamable HTTP). Their tools appear alongside the built-in ones, no special syntax needed to call them.

## Configuration

MCP servers are configured in JSON files using the common `mcpServers` shape:

| Location | Scope | Trust |
|----------|-------|-------|
| `~/.cast/mcp.json` | Global (all projects) | Always loaded |
| `.cast/mcp.json` | Project-local | Trust-gated |

### Local Server (stdio)

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@my-org/mcp-server"],
      "env": {
        "API_KEY": "optional-env-var"
      }
    }
  }
}
```

### Remote Server (streamable HTTP)

```json
{
  "mcpServers": {
    "context7": {
      "url": "https://mcp.context7.com/mcp",
      "headers": {
        "X-API-KEY": "your-api-key"
      }
    }
  }
}
```

### Config Fields

**stdio (local):**

| Field | Description |
|-------|-------------|
| `command` | Executable to run |
| `args` | Command arguments |
| `env` | Environment variables (optional) |
| `cwd` | Working directory (optional) |

Stdio servers inherit cast's **full environment**, with the config's `env` winning on conflicts — an API key exported in your shell reaches the server without duplicating it in the config. (The MCP SDK's default is a minimal whitelist; cast overrides it because a server that works when launched by hand should work identically under cast.)

**remote (`url`):**

| Field | Description |
|-------|-------------|
| `url` | Server endpoint URL |

Remote servers are connected over **Streamable HTTP** first; if the server rejects it (legacy servers answer the initialize POST with an HTTP error), cast retries once over the deprecated **HTTP+SSE** transport — so old `/sse` endpoints (e.g. Cloudflare's docs server) work with the same one-line config. Timeouts are not retried: a hung endpoint is hung on either transport.
| `headers` | HTTP headers for auth (static header/token only) |

Each server needs either `command` (local) or `url` (remote), not both.

## Tool Naming

MCP tools are namespaced as `mcp_<server>_<tool>`:

- Server `context7`, tool `resolve-library-id` → `mcp_context7_resolve-library-id`
- Server `my-server`, tool `search` → `mcp_my-server_search`

Non-alphanumeric characters in names are replaced with `_`.

## Connection

Servers connect in parallel during startup. Each gets a 30-second timeout — enough for `npx -y` cold cache resolution (~12s) without leaving a hung server unnoticed.

Failed connections produce a diagnostic message but don't block other servers or prevent cast from starting.

## CLI Flags

| Flag | Description |
|------|-------------|
| `--mcp <path>` | Load an extra MCP config file (repeatable) |
| `--no-mcp` | Skip global/project MCP server discovery |

```bash
cast --mcp ./custom-mcp.json
cast --no-mcp --mcp ~/.cast/mcp.json
```

Extra paths (`--mcp`) work even with `--no-mcp`.

## Commands

| Command | Description |
|---------|-------------|
| `/mcp` | Toggle MCP servers on/off (multi-select picker) |
| `/mcp list` | Read-only list (origin + tools/status) |
| `/mcp enable` / `disable <name>` | Toggle one server without the picker |
| `/mcp uninstall` | Remove a server from global/project `mcp.json` (picker + confirm, or typed name) |
| `/mcp help` | Cheat sheet |
| `/reload` | Reconnect MCP servers (re-reads config files) |

`/mcp uninstall` edits the owning config file (project wins over global for the same name). CLI `--mcp` paths are not removable here.

### Hot-reload

`/mcp` toggle / `enable` / `disable` / `uninstall` reconnect servers **in the current session** — no `/reload`, no restart.

Use `/reload` after editing `~/.cast/mcp.json` or `.cast/mcp.json` by hand (or adding a new server entry outside `/mcp`). See [Interactive commands](interactive-commands.md#hot-reload-vs-reload).

### Toggling Servers

`/mcp` opens an interactive multi-select picker showing all configured servers (global + project). Use **up/down** to navigate, **Space** to toggle a server on/off, and **Enter** to confirm.

Disabled servers:

- Are disconnected immediately (hot-swap, no restart needed)
- Are hidden from the model — their tools disappear from the system prompt
- Are persisted in `~/.cast/settings.json` — they stay disabled across sessions and `/reload`
- Can be re-enabled at any time by running `/mcp` again

The picker shows all servers from all config sources, regardless of connection status:

- `serverName (N tools)` — connected and enabled
- `serverName (disconnected)` — enabled but failed to connect
- `serverName (disabled)` — toggled off by the user

## Limitations

- **Transports**: stdio and streamable HTTP only. SSE transport is not supported.
- **Auth**: Static header/token authentication only. OAuth (browser redirect, token storage/refresh) is not supported.
- **Tool output**: Text, images, resource links, and embedded resources are handled. Audio content is noted but omitted.
