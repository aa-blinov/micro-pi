# Tools

The agent has access to 10 built-in tools plus optional MCP server tools. Multiple tools run in parallel within a single turn via `Promise.all`.

## File System Tools

### `read`

Read file contents. Supports text files and images (jpg, jpeg, png, gif, webp, bmp). Images are sent directly to vision-capable models.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | File path (relative or absolute) |
| `offset` | No | Line number to start from (1-indexed) |
| `limit` | No | Maximum lines to read |

Output is truncated to 2000 lines or 64KB. Images larger than 5MB are rejected.

### `write`

Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | File path |
| `content` | Yes | Content to write |

### `edit`

Edit a file using exact text replacement. Each `oldText` must match a unique, non-overlapping region of the file.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | File path |
| `edits` | Yes | Array of `{oldText, newText}` replacements |

If two changes touch the same block or nearby lines, they must be merged into one edit.

## Search Tools

### `find`

Search for files by glob pattern.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `pattern` | Yes | Glob pattern (e.g. `*.ts`, `**/*.json`, `src/**/*.spec.ts`) |
| `path` | No | Directory to search (default: cwd) |
| `limit` | No | Maximum results (default: 1000) |

### `grep`

Search file contents by regex pattern.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `pattern` | Yes | Regex or literal string |
| `path` | No | Directory or file to search (default: cwd) |
| `glob` | No | Filter by glob (e.g. `*.ts`) |
| `ignoreCase` | No | Case-insensitive search |
| `literal` | No | Treat pattern as literal string |
| `context` | No | Lines before/after each match |
| `limit` | No | Maximum matches (default: 100) |

### `ls`

List directory contents with file type, size, and name.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | No | Directory to list (default: cwd) |
| `limit` | No | Maximum entries (default: 500) |

## Shell Tool

### `bash`

Execute a bash command in the current working directory.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `command` | Yes | Bash command to execute |
| `timeout` | No | Timeout in seconds (default: 180) |

Output is truncated to the last 2000 lines or 64KB (whichever is hit first).

For long-running commands (docker build, npm install, large test suites), increase the timeout:

```
bash(command="npm run build", timeout=600)
```

## Web Tools

Web tools are disabled by default. Enable them with `/web` (persists to settings.json). When disabled, the tools are not advertised to the model — it doesn't know they exist.

### `web_search`

Search the web via DuckDuckGo. No API key required.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `query` | Yes | Search query |
| `maxResults` | No | Maximum results (default: 10) |
| `region` | No | Region code (default: `wt-wt`) |
| `time` | No | Time filter: `d` (day), `w` (week), `m` (month), `y` (year) |

### `web_fetch`

Fetch a web page and return clean markdown via Jina Reader. Handles JS rendering, PDFs, and content extraction.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `url` | Yes | URL to fetch |
| `maxChars` | No | Maximum characters (default: 12,000) |

## Task Tool

### `task`

Delegate a task to a sub-agent with an isolated context. The sub-agent runs independently — its intermediate tool calls don't appear in the main context. Only the final result is returned.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `assignment` | Yes | Complete, self-contained task description |
| `subagent` | No | Sub-agent name (e.g. `worker`) |

The `task` tool is only available when the current persona has `subagents: true` (e.g. the `coder-with-subagents` persona).

Use for:
- Parallel exploration (multiple sub-agents searching different parts of the codebase)
- Isolating complex research that would pollute the main context
- Delegating well-defined subtasks

## Plan Tools

Availability is mode-gated: authoring tools exist only in plan mode, progress and suggestion tools only in build mode, `plan_read` in both. See [Plan Mode](plan-mode.md) for details.

| Tool | Mode | Description |
|------|------|-------------|
| `plan_write` | Plan | Write or replace a named plan file |
| `plan_edit` | Plan | Edit a section of the active plan by heading |
| `plan_read` | Both | Read a plan's content and headings (switches the active plan only in plan mode) |
| `plan_done` | Plan | Signal that the plan is ready for review |
| `plan_discard` | Plan | Delete a plan from the session |
| `plan_enter` | Build | Suggest switching to plan mode |
| `plan_check` | Build | Mark a checklist item as done |

## Subagent System

The `task` tool delegates work to isolated sub-agents. Each sub-agent has:

- **Own system prompt** — loaded from `prompts/subagents/` (currently a `worker` prompt)
- **Isolated context** — the parent agent sees only the final result, not intermediate tool calls
- **Same built-in tools** — bash, read, write, edit, find, grep, ls (but no `task` — sub-agents can't delegate further)
- **Optional model override** — `/subagent-model` sets a different model for sub-agents

Sub-agent tokens are tracked separately in usage reporting (`/usage` status bar shows `sub` count).

The `task` tool is only available when the current persona has `subagents: true` (e.g. `coder-with-subagents`). Other personas can't see or invoke it.

## Doom Loop Detection

If the agent calls the same tool with identical arguments 3 times consecutively, the tool is blocked and the model receives an error:

```
Doom loop detected: tool "bash" was called 3 times consecutively with the same
arguments. You MUST try a completely different approach.
```

The counter resets when:
- A different tool call breaks the streak
- A steering or follow-up message is injected

This prevents the agent from getting stuck retrying the same failing operation.

## Vision Support

Images can be attached to messages and are sent directly to vision-capable models.

**Attach**: `Ctrl+G` opens a file picker. Supported formats: jpg, jpeg, png, gif, webp, bmp. Images larger than 5MB are rejected.

**Read tool**: When the `read` tool opens an image file, the image is sent as a separate user message alongside the tool result text.

**Fallback**: If the model doesn't support images (404 or vision error), cast strips image messages and retries with a warning: "Model doesn't support images — sending file path only".

## MCP Server Tools

Tools from connected MCP servers appear alongside the built-in ones. They're named `mcp_<server>_<tool>` (e.g. `mcp_context7_resolve-library-id`).

See [MCP Servers](mcp-servers.md) for configuration.

## Dangerous Command Gating

Bash commands matching known-dangerous patterns require confirmation before execution (unless `--bypass-permissions` is set or `/permissions bypass` is active).

Gated patterns include:

- `rm -rf` / `rm -r` with force flags
- `sudo`
- `git push --force` / `git push -f`
- `git reset --hard`
- `git clean -fd`
- Piping remote scripts into a shell (`curl | bash`)
- `chmod 777`
- `mkfs`, `dd`, writing to block devices
- Fork bombs
- `shutdown`, `reboot`, `poweroff`
- `npm publish`
- `killall`, `pkill`, `kill -9 -1`
- `git checkout .` / `git restore .`
- `rsync --delete`
- `find -delete`
- `xargs rm`
- `crontab -r`
- `iptables -F`
- Decoding base64 into a shell

File tools (`read`, `write`, `edit`) are never gated — they're trivially reversible via git.
