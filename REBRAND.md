# Rebrand: micro-pi -> Cast

## Legend
- `[x]` done

## Tasks

### 1. ASCII art banner
- [x] Add Cast ASCII art to startup (tui.tsx + index.ts via `CAST_BANNER` in help.ts)

### 2. Source code (`src/`)
- [x] `src/core/help.ts` — usage text + CAST_BANNER export
- [x] `src/core/upgrade.ts` — env vars (CAST_REPO, CAST_PAGES_BASE, CAST_API_BASE, CAST_VERSION), repo name, messages
- [x] `src/core/settings.ts` — `.cast`, comments
- [x] `src/core/session.ts` — `.cast/sessions`, comments
- [x] `src/core/rules.ts` — `.cast`, comments
- [x] `src/core/project.ts` — `.cast/skills`, `.cast/mcp.json`
- [x] `src/core/personas.ts` — comment
- [x] `src/core/mcp.ts` — client name, comment
- [x] `src/core/context-files.ts` — `.cast`, comments
- [x] `src/core/skills.ts` — `.cast/skills`, comments
- [x] `src/core/prompt.ts` — restart message
- [x] `src/index.ts` — display name, CAST_CWD, upgrade hint, banner
- [x] `src/ui/tui.tsx` — banner, loader text
- [x] `src/ui/App.tsx` — upgrade notice
- [x] `src/ui/commands.ts` — notices
- [x] `src/ui/gradient.ts` — comment
- [x] `src/ui/readClipboardImage.ts` — temp file prefix
- [x] `src/pickers/domain.ts` — settings path in message

### 3. Tests (`test/`)
- [x] All temp dir prefixes and `.cast` references (bulk sed)

### 4. Config files
- [x] `package.json` — name: "cast", bin: "cast": "./cast.sh"
- [x] `package-lock.json` — regenerated
- [x] `micro-pi.sh` -> `cast.sh` — renamed + content (CAST_CWD)
- [x] `bin/micro-pi` -> `bin/cast` — renamed + content (CAST_CWD)
- [x] `bin/micro-pi.cmd` -> `bin/cast.cmd` — renamed + content
- [x] `install.sh` — all refs (CAST_REPO, CAST_VERSION, ~/.cast, cast.tar.gz, bin/cast)
- [x] `install.ps1` — all refs (CAST_REPO, CAST_VERSION, ~/.cast, cast.zip, bin/cast)
- [x] `.github/workflows/release.yml` — archive names (cast-*.tar.gz, cast-*.zip)

### 5. Docs
- [x] `README.md`
- [x] `AGENTS.md`
- [x] `scripts/build.mjs` — comment

### 6. Evals
- [x] `evals/fixtures.ts`
- [x] `evals/cases/basic.ts`
- [x] `evals/results/latest.json` — left as-is (historical LLM output)

### 7. Verify
- [x] `npm run check` — clean
- [x] `npx vitest run` — 266/266 pass
- [x] `--help` shows "cast"
- [x] `--version` shows "cast v0.13.0 (dev)"
