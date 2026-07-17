# Changelog

All notable user-facing changes to cast, newest first.

## Unreleased

### Added

- After compaction (auto or `/compact`), cast injects a separate trailing `<system-reminder>` user message with edited files and a TODO list of open plan steps. Steps come from `- [ ]` checkboxes when present, otherwise from `###` headings under `## Steps` (common in real plans). Omitted when there is nothing actionable; summary text stays reminder-free.
- Turn-end open-work gate in build mode with an active plan: if the model stops without tool calls while plan steps remain open, cast injects a `<system-reminder>` and continues sampling (up to 2 times per user prompt, then falls through with an exhausted notice).

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
