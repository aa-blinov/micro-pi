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

Output is truncated to 2000 lines or 64KB. Images larger than 5MB are rejected. Each line is prefixed with a hashline anchor of the form `<LINE>:<LOCAL>:<CHUNK>→content` (e.g. `22:abc:rst`) so it can be passed directly to `edit`.

### `write`

Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | File path |
| `content` | Yes | Content to write |

### `edit`

Edit a file using hashline anchors from a recent `read` or `grep`. Each `op` targets a line (or range) by anchor instead of pasting text.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | File path |
| `ops` | Yes | Array of `replace` / `insert_after` / `insert_before` / `write` operations (see below) |

#### `ops[]` — anchor-based operations

Each op has an `op` discriminator and an inline `content`:

- `replace` — change one line or a range. Use `anchor` and an optional `end_anchor` (the range from `anchor` to `end_anchor` is INCLUSIVE on both ends). To delete lines, pass `content: ""`. To insert a line in the middle of the file, use `insert_after` instead.
  ```json
  { "op": "replace", "anchor": "42:abc:rst", "content": "    let x = 42;" }
  { "op": "replace", "anchor": "10:def:rst", "end_anchor": "12:ghi:rst", "content": "block of three lines\nspanning multiple\nlines" }
  ```
- `insert_after` — add new lines after the anchor. The new lines go between the anchored line and what was originally the next line; existing content is preserved.
  ```json
  { "op": "insert_after", "anchor": "42:abc:rst", "content": "new line one\nnew line two" }
  ```
- `insert_before` — add new lines above the anchored line. Same semantics as `insert_after` on the previous line, but the anchor names the line the text goes above — handy at section boundaries (headings, function starts).
  ```json
  { "op": "insert_before", "anchor": "42:abc:rst", "content": "// explanatory comment" }
  ```
- `write` — replace the entire file. No anchors required.
  ```json
  { "op": "write", "content": "full file content here" }
  ```

Multiple ops in one call are validated against the pre-edit file and applied atomically. If any anchor is stale, the whole batch is rejected. Two `replace` ops whose ranges overlap are also rejected — merge them into one op with a wider range.

A successful edit replies with the edited regions rendered with fresh anchors (±2 lines of context, overlapping windows merged, capped at 60 lines), so the result of the edit is immediately visible and follow-up ops can reuse the returned anchors without a re-`read`.

Anchors are self-healing where the answer is unambiguous: if the anchored content merely moved (lines inserted above it), or a neighbour in the same chunk changed while the anchored line itself is intact, the edit is applied automatically and the reply carries a `Note:` describing the recovery. The tool never guesses — a stale anchor whose content is gone, or one that matches several nearby lines, is still an error, and that error returns fresh anchors plus a snippet around the target line so a re-`read` is usually unnecessary.

#### Hashline anchors

Every line `read` and `grep` returns carries a two-part hash (the `chunk` anchor scheme from `xai-org/grok-build`): `LOCAL` fingerprints the line's own content, whitespace-normalized, so formatter-only edits don't invalidate anchors and a line that merely moved keeps its local hash; `CHUNK` fingerprints the 8-line chunk around the line, so nearby edits mark the anchor stale even when the line itself is untouched. To `edit` a line, copy the full `<line>:<local>:<chunk>` prefix into the `anchor` field of the op — do not re-type the line text.

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

Each output line is prefixed with the same hashline anchor as `read` (`<relPath>:<line>:<local>:<chunk>:<content>`), so a match can be edited without a separate `read`.

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

## SSH Tool

### `ssh`

Execute one command on a remote host via SSH. Only available when SSH hosts are configured.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `host` | Yes | Host name key from configured SSH hosts |
| `command` | Yes | Remote command to execute |
| `timeout` | No | Timeout in seconds (default: 180) |

Output is combined stdout+stderr, truncated to the last 2000 lines or 64KB.

### Configuration

SSH hosts are configured in `~/.cast/ssh.json` (global) or `.cast/ssh.json` (project):

```json
{
  "hosts": {
    "myserver": { "host": "192.168.1.10", "username": "deploy", "port": 22, "keyPath": "~/.ssh/id_ed25519" },
    "staging": { "host": "staging.example.com", "username": "admin", "password": "secret123" },
    "prod": { "host": "prod.example.com", "username": "root", "dangerousCommands": "bypass" }
  }
}
```

### Authentication

- **Key-based** (`keyPath`): Uses `ssh -i <keyPath>`. Key file must have `600` or stricter permissions.
- **Password-based** (`password`): Requires `sshpass` on PATH. Password is passed via `SSHPASS` env var (not CLI arg).
- When both `keyPath` and `password` are set, key takes priority.
- `~/.ssh/config` keys are also picked up automatically by ssh-agent.

### Connection Reuse

SSH connections are reused via ControlMaster (`ControlPersist=3600`). The first call to a host creates a master connection; subsequent calls reuse it through a Unix socket. This is transparent — no session state needed.

### Dangerous Commands

By default, the same safety check as bash applies (blocks `sudo`, `rm -rf`, etc.). Set `"dangerousCommands": "bypass"` per-host to skip the check for hosts where sudo is expected.

### Trust Gating

Project `.cast/ssh.json` requires trust (same as MCP servers and skills). The first time you use a project with SSH hosts configured, you'll be asked to trust the project.

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
