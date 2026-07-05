# Development Rules

## Conversational Style

- Short, direct, technical prose. No emojis anywhere (commits, PRs, code, chat).
- Answer the user's question before making edits or running commands.
- When responding to feedback or an analysis, say whether you agree or disagree before describing the change.

## Code Quality

- Read a file in full before making wide-ranging changes to it.
- No `any` unless truly unavoidable.
- Inline single-line helpers that have only one call site.
- Check `node_modules` for real external API types/signatures; don't guess.
- No inline imports (`await import()`, `import("pkg").Type`) — top-level only.
- Never remove/downgrade code to silence a type error from an outdated dep — upgrade the dep instead.
- Always ask before removing functionality that looks intentional.
- Comments explain *why* (hidden constraint, workaround, non-obvious invariant), never *what* — the code already says what.

## Project Structure

Paths below are relative to the repo root — there is no wrapping `cast/`
directory (the npm package is named `cast`, but the source lives directly under
`src/`). Source is split into `core/` (engine), `ui/` (Ink TUI), and
`pickers/` (onboarding pickers).

```
prompts/                    — system prompt, personas, tool/skill/compaction instructions (markdown)
  personas/                 — swappable persona prompt files
scripts/build.mjs           — esbuild bundle step (dist/index.js) for releases
bin/                        — published CLI launcher
src/
  index.ts                  — CLI entry point + arg parsing (delegates to core/startup.ts)
  core/                     — engine, no UI:
    startup.ts              — onboarding orchestration: provider/model/persona/reasoning, session/MCP/skills setup
    config.ts               — env/config loading, model validation, /v1/models discovery
    llm.ts                  — OpenAI client, streaming, retry/backoff, reasoning capture
    loop.ts                 — ReAct agent loop (steering/follow-up queues, compaction trigger)
    runner.ts               — per-turn run orchestration
    tools.ts                — 7 built-in tools: bash, read, write, edit, find, grep, ls
    permissions.ts          — dangerous-bash-pattern detection for the confirmation gate
    mcp.ts                  — MCP client: config loading, stdio/streamableHTTP connections, tool namespacing
    skills.ts               — Agent Skills discovery/validation (agentskills.io spec)
    personas.ts             — swappable system prompts
    project.ts              — per-cwd resolution of trust, skills, MCP, and system prompt
    context-files.ts        — AGENTS.md-style context-file loading
    rules.ts                — project/global rules (.cast/rules.md)
    frontmatter.ts          — shared frontmatter parser (skills.ts + personas.ts)
    session.ts              — message persistence, compaction, token/cost usage
    settings.ts             — ~/.cast/settings.json persistence
    readline.ts             — models cache + low-level input helpers
    vendors.ts              — reasoning metadata, <think> block parsing
    upgrade.ts / help.ts    — self-update flow, CLI help/banner text
  ui/                       — Ink TUI:
    tui.tsx                 — TUI entry point, mounts App, terminal resize handling
    App.tsx                 — root component: state wiring, status bar
    ChatLog.tsx             — transcript rendering (Static history, streaming, tool calls)
    Composer.tsx            — input box, slash-command palette, paste/keys
    Spinner.tsx             — loading spinner
    useAgentSession.ts      — agent turn/session React hook
    commands.ts             — slash-command routing (SLASH_COMMANDS, handleInput)
    pickerBridge.ts         — in-tree modal pickers used after mount
    gradient.ts             — brand gradient + banner helpers
    readClipboardImage.ts   — clipboard image paste
    input/                  — key parsing, keybindings, textarea buffer, word-nav
  pickers/                  — pre-mount onboarding pickers:
    domain.ts               — model/persona/reasoning/session/permission selection
    ink.tsx                 — Ink picker UI
    types.ts                — Pickers interface
test/                       — vitest, one test/<module>.test.ts per module
evals/                      — grounded regression eval runner (run.ts, cases/; see README's Eval Runner section)
```

## Commands

- `npm run check` — `tsc --noEmit && biome check src/ test/`. Run after every change; fix all errors before committing.
- `npm test` — full vitest suite. `npx vitest run test/<file>.test.ts` for one file.
- `npm run format` — `biome format --write`. Formatting: tabs, width 3, 120-col lines (see `biome.json`).
- `npm run build` — bundles `src/index.ts` + deps into `dist/index.js` (minified) via esbuild. What release archives ship; not needed for day-to-day dev (`npm start` runs straight from `src/` via tsx).

## Testing

- Framework: vitest, one `test/<module>.test.ts` per `src/<module>.ts`.
- No real LLM/provider API calls — use mock configs with a fake `baseURL`/`apiKey`.
- MCP tests are the one deliberate exception to "no real calls": `test/mcp.test.ts` spawns an actual local test-fixture MCP server (`test/fixtures/mcp-echo-server.mjs`, stdio and `--http`) and drives it through the real protocol — not mocked, because the point is to catch protocol-shape drift, not just exercise our own glue code.
- Tool tests use a temp dir (`test/__test_tmp__/`), created in `beforeEach`, removed in `afterEach`.
- After adding/changing a tool, skill, persona, or MCP behavior: add or update its test file in the same change.

## Dependency Security

- Direct deps use caret ranges (see `package.json`) — treat any `package.json`/`package-lock.json` diff as reviewed code, same scrutiny as source.
- Install with `npm install --ignore-scripts`.

## Git, Commits & Releases

- Only commit files changed in the current session. Stage explicit paths (`git add <path>...`), never `git add -A`.
- Commit message: `type: imperative summary` (`feat|fix|chore|docs|test`), body explains *why*.
- **Before any commit**, in order — all three must be clean:
  1. `npm run check` (types + lint)
  2. `npm test` (full suite)
  3. `npm run build` (confirms the release bundle still compiles)
- **Version bumps are their own commit**, separate from the feature/fix commit that motivated them (see git log for the pattern): `npm version patch|minor --no-git-tag-version`, then commit `package.json`+`package-lock.json` alone as `chore: bump version to X.Y.Z`, body referencing the commit it's releasing.
  - patch: small additions/fixes; minor: a new user-facing feature (e.g. MCP support was 0.2.1 → 0.3.0).
- **Releasing**: annotate-tag the bump commit (`git tag -a vX.Y.Z -m vX.Y.Z`), then `git push origin master && git push origin vX.Y.Z`. The tag push triggers `.github/workflows/release.yml` (check → test → build → package archives → publish GitHub Release) — `.github/workflows/ci.yml` already covers plain pushes/PRs to `master` across Node 18/20/22, so tags don't re-need a separate CI run for that.
- Pushing a tag publishes a release immediately and is what `cast upgrade` fetches — treat it as a real shipping action, not a checkpoint.

## Architecture Decisions

- Single provider via `PROVIDER_BASE_URL`/`PROVIDER_API_KEY` (OpenAI-compatible only). Resolution order: env vars > `~/.cast/settings.json` > interactive prompt on first run (`resolveConnection`).
- Compaction: LLM-based summarization past a token threshold derived from the model's real context window (falls back to pruning).
- Parallel tool execution: tool calls within one assistant message run concurrently via `Promise.all`.
- Steering (`/steer`) and follow-up (`/followup`/`/fu`) queues inject/queue messages around agent turns; queue mode is "one-at-a-time" or "all".
- Reasoning: no vendor detection — `vendors.ts` reads `reasoning` metadata from `/v1/models` and sends the unified OpenRouter `reasoning.effort` param, plus parses raw `<think>` blocks. Selected at onboarding, changeable via `/reasoning`.
- Skills (agentskills.io) and MCP servers share one loading pattern: global path loads unconditionally, project path (`.cast/skills/`, `.cast/mcp.json`) is trust-gated per project and remembered in settings. `/reload` re-runs both for the current cwd without restarting the process.
- MCP: stdio and streamable-HTTP transports only; static header/token auth, deliberately no OAuth (see `mcp.ts` header comment). Tool names namespaced `mcp_<server>_<tool>`.
- No TUI, no server, no orchestrator — pure CLI with `node:readline`.
