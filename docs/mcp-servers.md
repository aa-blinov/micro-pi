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

**streamable HTTP (remote):**

| Field | Description |
|-------|-------------|
| `url` | Server endpoint URL |
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
| `/reload` | Reconnect MCP servers (re-reads config files) |

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
