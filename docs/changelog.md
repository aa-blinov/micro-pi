# Changelog

All notable user-facing changes to cast, newest first.

## 0.7.5

### Added

- Personas travel with the thread: each session remembers the persona that drove it, and resuming (`-c`, `--resume`, `/sessions`) restores it — same rule as plan/build mode. The global setting remains the default for new sessions; a deleted persona falls back to the current one with a notice.
- Switching to a different persona (`/persona`) in a non-empty thread now offers to start a new session, so the previous persona's context doesn't bleed into the new role; "Continue here" / Esc keeps the current thread.
- Four new built-in personas rounding out the IT-company role set: `architect` (trade-off analysis, ADRs, module boundaries), `analyst` (requirements from vague asks, contradictions, API contracts), `sre` (incident response, blameless postmortems, SLOs), and `product` (hypotheses, success metrics, prioritization — distinct from the ticket-writing Project Manager).
- Built-in persona `coder-with-subagents-force-review` (Coder · forced review): same delegation as `coder-with-subagents`, plus a mandatory review gate — every code change goes through an independent `review` sub-agent (fresh context, diff-based input, execution-confirmed findings, exactly one round) before being reported done. No "too trivial to review" exception for code.

## 0.7.4

### Fixed

- Provider requests fail on Node 24 with "Cannot connect … (invalid content-length header)": the OpenAI SDK sets an explicit `content-length` header, which is a forbidden fetch request header — Node 24's undici rejects the request outright (Node 26 silently ignores it). cast now strips it and lets the runtime compute the value; model selection/chat work on Node 24 again.

## 0.7.3

### Fixed

- Windows: `cast upgrade` no longer crashes on exit with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` — the hard `process.exit()` right after the release-check fetch raced libuv's handle teardown; the command now returns and lets the process exit naturally.

## 0.7.2

### Fixed

- "Cannot connect to <url>" errors now include the underlying network detail (`ECONNREFUSED` / `ENOTFOUND` / certificate errors, including ones buried in undici AggregateErrors) — DNS, dead-endpoint, and TLS-interception failures need different fixes and were indistinguishable.
- Windows: the Git Bash registry probe no longer leaks `reg.exe`'s localized stderr into the TUI as mojibake when the GitForWindows key is absent.

## 0.7.1

### Added

- Fuzzy search in the session picker (`--resume`, `/sessions`): type to filter by project path, session id, or any user/assistant message text in the thread; substring matches rank above subsequence (typo-tolerant) matches. `Esc` is the only cancel key while searching — `q` goes into the query.
- `write` replies with a line diff vs the previous content (plus trailing-newline notes) instead of a byte count; new-file and identical-content cases are reported explicitly.
- `write` and `edit` warn when the resulting file contains consecutive identical lines — the classic symptom of a duplicated-line botch.
- `edit` auto-recovers a stale anchor that matches a run of contiguous byte-identical duplicate lines (they're interchangeable), instead of dead-ending with "multiple lines match".
- Windows: the `bash` tool locates a native Git Bash (CAST_BASH env override → GitForWindows registry key → known install paths incl. no-admin and scoop → derivation from `git` on PATH) instead of picking up the WSL shim from PATH, which loses output. Falling back to PATH bash warns at startup and in the first tool result.
- Session summary index (`~/.cast/sessions/index.json`): the picker lists hundreds of sessions from an mtime-validated cache (~5ms warm) instead of parsing every session file; the full session is parsed only for the one you pick. Self-healing — safe to delete.
- `cast -c` finds the most recent session by file mtime and parses only that file (was: parse everything).

### Fixed

- Prompt-cache markers (`cache_control`) no longer leak into saved sessions: `applyCacheControl` works on request-only copies, and loading normalizes sessions damaged by older builds — fixes opaque 400s ("Can only get item pairs from a mapping") when resuming after a provider switch.
- Resuming a session created on a different provider falls back to the currently configured model (with a notice) instead of sending requests to a model the new provider doesn't serve.
- Tool-call arguments that are valid JSON but not an object (e.g. a bare array) are wrapped before sending, so providers whose chat template iterates arguments as a mapping don't reject the whole history.
- Stdio MCP servers inherit cast's full environment (config `env` wins) — shell-exported API keys now reach servers; the SDK's whitelist default silently stripped them.
- Remote MCP servers that only speak the legacy HTTP+SSE transport now connect: Streamable HTTP is tried first, then one SSE retry on rejection. SSE JSON-RPC POSTs run on a dedicated connection pool — the long-lived `/sse` stream otherwise serializes them behind itself in Node's fetch and the handshake hangs forever.
- SKILL.md / persona / rules frontmatter survives a UTF-8 BOM (Windows Notepad, `Out-File`); previously the whole frontmatter was silently discarded.
- Plugin marketplace commands report "git is not installed or not in PATH" instead of a raw `spawn git ENOENT`; staging directory names derived from Windows local paths no longer contain `\` or `:`; marketplace install retries `rm`/rename against transient Windows EPERM/EBUSY locks.
- `getMostRecentSession` skips a corrupt (half-written) newest session file and falls back to the next one.
- `bash` tool reports a clean error when the bash executable itself can't be spawned (e.g. a wrong `CAST_BASH`), instead of hanging.

### Changed

- Docs: provider credentials are configured only via `~/.cast/settings.json` / `/provider` — the `PROVIDER_BASE_URL` / `PROVIDER_API_KEY` environment variables were documented but never read; the docs no longer claim otherwise.
- Minimum Node.js version raised from 18 to 22 (required by undici 8.x used for MCP SSE transport).

## 0.7.0

### Added

- After compaction (auto or `/compact`), cast injects a separate trailing `<system-reminder>` user message with edited files and a TODO list of open plan steps. Steps come from `- [ ]` checkboxes when present, otherwise from `###` headings under `## Steps` (common in real plans). Omitted when there is nothing actionable; summary text stays reminder-free.
- Turn-end open-work gate in build mode with an active plan: if the model stops without tool calls while plan steps remain open, cast injects a `<system-reminder>` and continues sampling (up to 2 times per user prompt, then falls through with an exhausted notice).
- After a mid-stream `/abort` (Esc) with no tool-result abort signal, cast appends a `<system-reminder>` (`[Request interrupted by user]`) so the next turn’s model sees that the prior turn was cut off.
- Overnight sessions get a one-shot `<system-reminder>` when the local calendar date advances past the last announced day (persisted per session).
- Built-in `explore` and `review` subagents for `task` (read-oriented tool allowlists). `coder-with-subagents` steers mapping to `explore` and validation to `review`; `worker` remains the default catch-all for everything else.
- Marketplace plugins (Grok/Claude-shaped): `/plugin marketplace add`, `/plugin install name@marketplace` — installs contribute skills from `~/.cast/plugins/`.
- `/skills` and bare `/plugin` open multi-select toggles (same UX as `/mcp`); disabled skill names persist in `disabledSkills`.
- Default marketplaces auto-seeded once: Codex (`openai/plugins`), Claude (`anthropics/claude-plugins-official`), Grok (`xai-org/plugin-marketplace`).
- `/plugin` slash palette lists install / marketplace / toggle subcommands; builtin `cast` skill documents plugins + toggles.
- Bare `/plugin uninstall` opens a picker + confirm (typed `name@marketplace` still works).
- `/skills uninstall` and `/mcp uninstall` — interactive picker + confirm (or typed name); removes global/project skills and mcp.json entries, clears matching disable flags, hot-reloads.
- Uniform `/skills` / `/mcp` / `/plugin` surface: `list`, `enable`/`disable`, `help`; toggle cancel shows `[Cancelled]`; no-op toggle skips reload; typed uninstall confirms; `/plugin marketplace remove` cleans settings + reloads skills.
- Skill discovery loads skills.sh universal paths: `.agents/skills/` (project, trust-gated) and `~/.config/agents/skills/` / `~/.agents/skills/` (global), so `npx skills add … -a universal` works without copying into `.cast/skills/`.
- `/skills`, `/mcp`, and `/plugin` pickers/lists sort entries alphabetically by name (skills were previously discovery-order, so plugin skills clustered at the bottom).
- `/skills` labels plugin skills with their pack id (`plugin · name@marketplace`). Skills from a disabled pack stay visible but locked (muted) until `/plugin` re-enables the pack.
- `/skills uninstall` lists plugin skills as muted/locked (remove the pack via `/plugin uninstall`); Enter on those rows is ignored.

### Fixed

- `read` tool rows show the correct 1-indexed line range (was off-by-one when `offset` was set).
- Live-region `task` rows stay one-line (truncate) while streaming so parallel tasks remain visible; full wrapped assignment still shows once promoted to history.
- Committed `task` tool rows show the full subagent report (wrapped), not a 500-char truncated line.
- Session rebuild/resume restores tool `[error]` via persisted `castIsError` on tool results (was always `[ok]`).
- Trackpad scroll during an active agent turn no longer fights Ink redraws: while the live region fits the screen, cursor-position polling stays on (and short CUU frames cannot clear the scroll-up guard); tall streaming frames skip that poll so a false scroll latch cannot swallow redraws and scramble scrollback.
- Sync `task` subagents honor parent `--no-skills` / `--skill` (they previously always loaded global/builtin/plugin skills and ignored CLI skill paths).

### Changed

- Docs spell out hot-reload vs `/reload`: `/skills` / `/mcp` / `/plugin` toggle and install/uninstall apply in-session; `/reload` is only for on-disk file drops/edits (same chat, no restart).
- `/skills` / `/mcp` / `/plugin` pickers put the full description on the focused second line (wrap), not truncated into the label.
- `task` UI shows the delegated assignment text (not raw JSON `key=value` args). Non-default subagent names are prefixed (`explore · …`).
- Subagent final-answer extraction ignores empty placeholder turns (`(no response)`); the worker prompt requires a standalone closing report.
- Sync `task` subagents now receive the same environment grounding as the parent: Current System State (cwd/date/platform/model), always-apply + lazy rules, skills catalog, MCP server list, and SSH hosts.
- `--no-skills` help/docs clarify that plugin skill discovery is skipped too (behavior unchanged).
- `coder-with-subagents` (and the `task` tool description) steers harder on user cues like “parallel” / “independently”: split into same-turn multi-`task` calls instead of solo exploration.
- Shared prompt append adds Agent discipline (action safety, parallel tool calls, preamble-with-tools, prompt secrecy) for all personas and subagents.

## 0.6.12

### Changed

- Renamed the file-search builtin from `find` to `glob` (same glob-pattern behavior). Legacy `find` calls and `tools: [find, …]` allowlists still work.
- Shared file-tool guidance steers named-file tasks to `read` first; short `glob` results remind the model to `read` a hit instead of another search/`ls`.
- `edit` `insert_after` accepts anchor `EOF` to append at the end of a file (alongside existing `0:` for the top).

### Fixed

- `edit` recovers unique hash-only anchors when the model omits the line number (`local:chunk` instead of `22:local:chunk`), and accepts ASCII `->` gutters the same way as `→`.
- Shared file-tool guidance (all personas **and** subagents) now spells out the read→edit workflow: known path skips `glob`, one `edit` per file, copy the full three-part anchor, retry from tool-returned anchors instead of re-searching.
- When `read`/`edit` miss a path, cast runs a basename `glob` under the hood and lists real matches so the model can retry the correct path without starting its own search loop.

## 0.6.11

### Added

- Persona and subagent frontmatter support `tools` (builtin allowlist; exact names or `*`-globs like `plan_*` / `web_*`) and `agentsMd` (default `true`). Omit `tools` for all builtins; MCP tools are never filtered by the allowlist. Session gates (plan/build mode, web toggle) still apply on top.

## 0.6.10

### Fixed

- `edit` returns edited regions with fresh anchors on success, so a follow-up edit on the same file no longer needs a re-read after lines shift under prior anchors.
- `read` output was switched from the two-part `<LINE>:<HASH>→` anchor format to the three-part `<LINE>:<LOCAL>:<CHUNK>→` format (introduced during the 0.6.9 cycle). The three-part form gives finer-grained movement detection when lines shift around, and the stale-anchor error path now returns a fresh anchor instead of failing blind.

## 0.6.9

### Added

- `edit` now accepts `insert_before` to add new lines above a target anchor (in addition to the existing `insert_after`). Useful when the natural reference is a heading you want content to sit *above* rather than below.
- Successful `edit` operations now return the edited regions with fresh anchors, so a follow-up edit doesn't need a re-`read` even when prior anchors shifted.

## 0.6.8

### Changed

- **Hashline anchor format switched from `<LINE>:<HASH>` to `<LINE>:<LOCAL>:<CHUNK>`** for `read`/`edit`/`grep` output. The three-part form gives finer-grained movement detection when lines shift around, and the stale-anchor error path now returns a fresh anchor instead of failing blind. Anchors emitted under 0.6.7 are no longer valid; re-read the file to get anchors in the new format.

### Fixed

- `parseAnchor` now ignores any content past the `→` separator, so pasting a `read` gutter line (with its arrow and trailing content) into `edit` produces the correct anchor instead of a malformed one.

## 0.6.7

### Changed

- **`read` output now carries hashline anchors** in the form `<LINE>:<HASH>→content` so a line reference made in one assistant turn still points at the same line after a re-read; `edit` accepts `replace` / `insert_after` / `write` operations keyed by those anchors and validates the whole batch atomically against the current file (stale anchors return fresh anchors instead of failing blind).

### Internal

- Per-line hash computation for `read`/`edit`/`grep` is now backed by an in-memory LRU (default 20 entries, ~4 MB worst case). Entries are re-validated against file `mtime` on every access, so cache hits silently invalidate after external edits.
- `Lru` exposes a `size` getter so the test-only `hashlineCacheSize` no longer reaches into a private field.

### Internal

- `read`/`edit` now emit and accept hashline anchors (`<LINE>:<HASH>→…`) so line references in the conversation survive re-reads; edits are validated atomically against the file as it stands at edit time
- In-memory LRU (default 20 entries, ~4 MB worst case) caches per-line hashes for `read`/`edit`/`grep`; entries are re-validated against file `mtime`, so cache hits silently invalidate on external edits
- Added a public `size` getter on the LRU so `hashlineCacheSize` no longer reaches into a private field

### Changed

- **`/current` model line shows the configured model and the live plan model together** when plan mode swaps in a separate one, so the discrepancy from the status bar becomes visible instead of silently different.

### Internal

- `/current` rendering moved into `formatValue` on each registered status bar segment — adding a new segment now needs one place instead of two.
- `applyProviderSelection` extracted from `/provider activate` — the post-save flow (`selectModel` → `selectReasoningLevel` → `refresh`) lives in one helper. `/provider add` keeps its own notice wording and stays inline.
- `/current` and `/usage` reuse `abbreviateTokens` and `formatContextPct` from `App.tsx` — local `fmtK` (no M-branch) and a duplicated context-percent formatter are gone.
- Hermes XML strip is a single function (`stripHermesToolCalls`) shared by `core/llm.ts` and the streaming path — the previously duplicated private copy was deleted.
- `ensureConnectionAlive` now writes the full providers array (not just legacy `providerUrl`/`apiKey`); the regression test was tightened to assert exactly what gets persisted, including that existing providers survive a reconnect prompt.
- New `test/statusbar.test.ts` covers `defaultStatusBarConfig`, the `SEGMENT_MAX_WIDTH` overflow map, and the empty-data paths of the registered renderers; new `formatValue` tests cover the plan-mode model divergence.

## 0.6.5

### Added

- **Multi-provider support** — `/provider` now opens a picker to switch between saved providers; `/provider add` adds a new provider (name → URL → key wizard); `/provider delete` removes one. Providers persist in `settings.json` and the active one is remembered across sessions.

## 0.6.4

### Fixed

- **Hermes tool-call recovery** — XML `<function=…>` blocks in assistant prose (e.g. the model describing the feature itself) are no longer mis-parsed as live tool calls, preventing `400 Param Incorrect` loops on the next request. Recovery and dedup-strip now gate on actual tool names from the current session.

## 0.6.3

### Fixed

- **Streaming dedup** — Hermes models that emit both XML `<tool_call>` blocks and native function-calling in the same response no longer produce duplicate tool invocations

## 0.6.2

### Added

- `/statusbar` command — toggle, reorder, and reassign status bar segments between left/right sides via an interactive picker. Config persists across sessions. Useful on narrow/mobile terminals where the full bar overflows. Default: persona, mode, model (left) and elapsed (right); toggle others via `/statusbar`.
- `/current` command — show all status bar data in a list, including disabled segments

## 0.6.1

### Fixed

- **Terminal resync** — resize and focus-regain now use a light clear that preserves scroll position; theme changes and streaming desyncs still do a full scrollback wipe
- **lineChurn** — O(m·n) fallback for large edits uses Set-based comparison instead of raw block count; identical large texts no longer report false positive changes
- **Input parser** — DECXCPR cursor-position responses (`\x1b[row;colR`) explicitly dropped to prevent accidental keybinding matches

### Internal

- `displayWidth` extracted to `src/ui/display-width.ts` with per-session cache
- Test directories isolated to prevent parallel test collisions

## 0.6.0

### Added

- **SSH tool** — run commands on remote hosts via SSH; hosts configured in `~/.cast/ssh.json` (global) or `.cast/ssh.json` (project)
- `/queue-reset` alias — shortcut for clearing the command queue

## 0.5.8

### Added

- MCP server toggle — `/mcp` now opens an interactive multi-select picker to enable/disable individual servers mid-session. Disabled servers are hidden from the model and persisted in settings.
- `<available_mcp>` block in the system prompt — the model sees only enabled MCP servers and their tools, and will not attempt to call disabled ones.
- Hermes XML tool-call parsing and recovery
- Terminal desync tracking with automatic resync on focus return

## 0.5.7

### Added

- Enhanced search functionality with permission handling and output notes
- Improved tool name sanitization to prevent doom loops

## 0.5.6

### Fixed

- Terminal tools (`plan_done`, `plan_enter`) now force-end the turn — prevents the model from keeping runs alive by rewording summaries to dodge the doom-loop detector
- `plan_done` no longer echoes full plan content into model context, which invited endless "refinement" loops

## 0.5.5

### Added

- Changelog page with version history from 0.1.0 to 0.5.4
- Sequential prev/next navigation on all documentation pages (reading loop: Getting Started → ... → Changelog → Getting Started)
- `/usage` command documented in README and interactive commands reference
- Plan mode refine option uses the regular composer (multi-line and image paste supported)

### Fixed

- Improved provider error classification — OpenAI SDK `APIConnectionError` cause chain is now fully traversed for accurate error reporting

## 0.5.4

Fix: ensure non-negative token counts in usage tracking and streaming.

## 0.5.3

Fix: `/usage` now correctly shows sub-agent token breakdown.

## 0.5.2

### Added

- `/usage` command — show cumulative session token/cost usage
- `/exit` command — alias for `/quit`

## 0.5.1

### Changed

- Repositioned cast as a "role-based agent harness" — 13 built-in personas, same tools, different judgment

## 0.5.0

### Added

- **Plan mode** — `/plan` enters a read-only exploration phase; the agent studies the codebase and writes a structured execution plan with a checklist
- Plan tools: `plan_write`, `plan_edit`, `plan_read`, `plan_done`, `plan_discard`, `plan_enter`, `plan_check`
- Per-phase model support — `/plan-model` sets a separate model for planning vs building
- Plan files persist as markdown in `~/.cast/plans/`; survive compaction and session restarts
- Approval dialog: implement now, clear context + implement, approve for later, or refine
- E2E smoke test for plan mode

### Changed

- Comprehensive documentation overhaul — all features now documented in `docs/`

## 0.4.7

### Added

- Improved picker viewport handling with scrolling and index clamping
- 8 new dangerous bash patterns (fork bombs, `shutdown`, `npm publish`, `killall`, etc.)

## 0.4.6

### Changed

- Enhanced dangerous command detection in permissions

## 0.4.5

### Changed

- Removed interactive command checks from permissions (simplified)

## 0.4.4

### Added

- **Web tools** — `web_search` (DuckDuckGo) and `web_fetch` (Jina Reader) for internet access
- Web tools are off by default; toggle with `/web` (persists to settings)

## 0.4.3

### Added

- **Doom loop detection** — blocks a tool after 3 identical consecutive calls with the same arguments

### Fixed

- Streaming viewport clamping and scroll position issues

## 0.4.2

### Added

- `/copy` command — copy last assistant response to clipboard

### Fixed

- Scroll position not resetting on resync while user is scrolled up

## 0.4.1

### Fixed

- Atomic writes for session and settings files (prevents corruption on crash)
- Session listing and MCP connect timeout hardening
- Clear error on missing required prompt files
- Persona sorting uses label instead of name

### Changed

- Split `tools.ts` into per-tool modules (`bash.ts`, `files.ts`, `search.ts`, `web.ts`, `task.ts`)
- Centralized prompts directory resolution

## 0.4.0

### Added

- Multi-source personas — project-local, global, and builtin with priority ordering
- Sub-agent support via the `task` tool — delegate work to isolated sub-agents
- `coder-with-subagents` persona

## 0.3.17

### Added

- Brace expansion in glob patterns
- Enhanced gitignore handling

### Changed

- Agent loop and UI performance tracking improvements

## 0.3.16

### Added

- **Non-interactive mode** — `cast run` sends a single prompt, streams to stdout, exits
- `--format json` for structured JSONL output

## 0.3.15

### Added

- `/repo` command — show cwd, git branch, dirty state, remote, and HEAD
- Multiple color themes (16 total)

## 0.3.13

### Added

- Theme support — `/theme` picker, persisted to settings

## 0.3.12

### Fixed

- Made node-pty optional with pipe fallback for release bundles

## 0.3.11

### Added

- PTY for bash commands — captures interactive prompts (e.g. `npm init`)

## 0.3.10

### Fixed

- Live bash command reveal only when waiting for input

## 0.3.9

### Added

- Re-pick model when provider token changes at startup
- Custom model id entry in picker
- Surface actionable turn errors (revoked key, quota exceeded, no access)
- Recover from dead provider connection at startup
- Esc stops the running turn; Ctrl+C exits with confirmation

### Fixed

- Provider key persistence on re-entry
- Distinguish aborted, disconnected, and completed turns at stream end

## 0.3.8

### Changed

- Streaming and rendering logic overhaul for chat messages

## 0.3.7

### Added

- StdinManager for handling interactive input in child processes

### Changed

- Streamlined session handling

## 0.3.6

### Fixed

- Inline model context windows map (removed external JSON file dependency)

## 0.3.5

### Changed

- Documentation updates

## 0.3.4

### Fixed

- Message sanitization and tool call handling

## 0.3.3

### Fixed

- `/steer` behavior when idle (now submits as normal prompt)

## 0.3.2

### Added

- Paste chip functionality in Composer
- Command aliases: `/s` for `/steer`, `/q` for `/queue`
- Nested context file resolution (AGENTS.md in subdirectories)

## 0.3.0

### Added

- **Rules system** — Cursor-compatible `.cast/rules/*.md` with always/auto/lazy/manual modes
- `@rule-name` mentions in messages
- Chat log display improvements (clampTailToRows)

## 0.2.3

### Added

- System state block in system prompt (model, reasoning, cwd, git branch)

## 0.2.1

### Added

- `/keys` command — list all keybindings

## 0.2.0

### Added

- Multi-source personas (project > global > builtin)
- Built-in skills
- Cast meta-skill for self-configuration

## 0.1.4

### Fixed

- Token count abbreviation in status line (8.7k, 1.2M)

## 0.1.3

### Added

- `/model` highlights current selection in picker
- Honest reasoning display

## 0.1.2

### Fixed

- `reasoning_content` field support
- Resize reflow
- Tool call summaries
- `/steer` and `/queue` validation

## 0.1.1

### Fixed

- ThinkBlockParser off-by-one
- Added QA personas and vendors tests

## 0.1.0

Initial release. Ink TUI, 13 built-in personas, OpenAI-compatible provider, session persistence, context compaction, MCP servers, skills, parallel tool execution, sub-agents.
