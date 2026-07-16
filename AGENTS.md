# Development Rules

## Conversational Style

- Short, direct, technical prose. No emojis.
- Answer the user's question before making edits or running commands.
- When responding to feedback, say whether you agree or disagree before describing the change.

## Code Quality

- Read a file in full before making wide-ranging changes to it.
- No `any` unless truly unavoidable.
- Inline single-line helpers that have only one call site.
- Check `node_modules` for real external API types/signatures; don't guess.
- No inline imports (`await import()`, `import("pkg").Type`) — top-level only.
- Never remove/downgrade code to silence a type error from an outdated dep — upgrade the dep instead.
- Always ask before removing functionality that looks intentional.
- Comments explain *why*, never *what*.

## Project Layout

The npm package is `cast`, but source lives directly under `src/` (no wrapping `cast/` dir).

**Source code** — always `src/`:
- `src/core/` — engine (no UI): loop, tools, LLM, session, config, MCP, skills, personas
- `src/ui/` — Ink TUI: App, ChatLog, Composer, commands, input handling
- `src/pickers/` — onboarding pickers (model/persona/reasoning selection)

**Other top-level dirs** — not source code:
- `prompts/` — system prompt, persona, compaction markdown files
- `test/` — vitest, one `test/<module>.test.ts` per `src/<module>.ts`
- `evals/` — regression eval runner (not part of the main application)
- `bin/` — published CLI launcher
- `scripts/` — esbuild bundle step

When the user asks about "code", "source", "сколько кода", or similar — they mean `src/`. Never navigate to `evals/`, `test/`, or `scripts/` unless explicitly asked.

## Commands

Always run in this order before committing:
1. `npm run check` — `tsc --noEmit && biome check src/ test/`
2. `npm test` — full vitest suite
3. `npm run build` — bundles into `dist/index.js` via esbuild

Other:
- `npm run format` — `biome format --write` (tabs, width 3, 120-col)
- `npx vitest run test/<file>.test.ts` — run one test file

## Testing

- Framework: vitest, one `test/<module>.test.ts` per `src/<module>.ts`.
- No real LLM/provider API calls — use mock configs with a fake `baseURL`/`apiKey`.
- MCP tests are the one exception: `test/mcp.test.ts` spawns a real local test-fixture server.
- Tool tests use `test/__test_tmp__/`, created in `beforeEach`, removed in `afterEach`.
- After adding/changing a tool, skill, persona, or MCP behavior: add or update its test file in the same change.

## Git & Commits

- Only commit files changed in the current session. Stage explicit paths (`git add <path>...`), never `git add -A`.
- Commit message: `type: imperative summary` (`feat|fix|chore|docs|test`), body explains *why*.

## Release Process

When the user says "make a release", follow these steps in order:

### 1. Determine the version bump

| Bump | When | npm command | Example |
|------|------|-------------|---------|
| **patch** | Bug fixes, small tweaks, internal improvements | `npm version patch --no-git-tag-version` | 0.6.0 → 0.6.1 |
| **minor** | New user-facing features, non-breaking additions | `npm version minor --no-git-tag-version` | 0.6.0 → 0.7.0 |
| **major** | Breaking changes, major rewrites, dropping features | `npm version major --no-git-tag-version` | 0.6.0 → 1.0.0 |

Pre-1.0 (current): minor bumps feel like patches to users. Use minor for features worth advertising, patch for everything else.

### 2. Update docs/changelog.md

- Add a new `## X.Y.Z` section at the top (no `v` prefix — matching existing style).
- Group changes under `### Added`, `### Fixed`, `### Changed`, `### Internal` as applicable.
- Summarize user-visible impact, not commit messages.

### 3. Pre-release checks

```
npm run check && npm test && npm run build
```

All three must pass. If any fails, fix first.

### 4. Commit the release

```
git add package.json package-lock.json docs/changelog.md
git commit -m "chore: bump version to X.Y.Z"
```

If AGENTS.md or other docs were updated in the same session, include them in the same commit.

### 5. Tag and push

```
git tag -a vX.Y.Z -m vX.Y.Z
git push origin master && git push origin vX.Y.Z
```

Tag push triggers the release workflow on CI.

### 6. Verify release

```bash
# Confirm tag on remote
git ls-remote --tags origin vX.Y.Z

# Check CI workflow status
gh run list --workflow=release.yml --limit=1

# If workflow failed, inspect logs
gh run view <run-id> --log-failed

# Confirm the GitHub release was created
gh release view vX.Y.Z
```

If the workflow is still running, wait and re-check. Do not declare the release done until CI passes.

## Dependency Security

- Direct deps use caret ranges — treat `package.json`/`package-lock.json` diffs as reviewed code.
- Install with `npm install --ignore-scripts`.

## Architecture

- Single OpenAI-compatible provider via `PROVIDER_BASE_URL`/`PROVIDER_API_KEY`.
- Compaction: LLM-based summarization past a token threshold (falls back to pruning).
- Parallel tool execution: tool calls within one assistant message run concurrently via `Promise.all`.
- Reasoning: `vendors.ts` reads metadata from `/v1/models`, sends `reasoning.effort` param, parses `<think>` blocks.
- Skills and MCP servers: global path loads unconditionally, project path (`.cast/skills/`, `.cast/mcp.json`) is trust-gated.
- MCP: stdio and streamable-HTTP only; tool names namespaced `mcp_<server>_<tool>`.
- Pure CLI with `node:readline` — no TUI framework, no server, no orchestrator.
