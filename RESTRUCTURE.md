# Restructure Task List

## Goal
Separate UI and agent core logic in `src/` for better navigation and maintainability.

## New Structure
```
src/
├── core/           # Agent logic (no UI dependencies)
│   ├── config.ts
│   ├── context-files.ts
│   ├── frontmatter.ts
│   ├── help.ts
│   ├── llm.ts
│   ├── loop.ts
│   ├── mcp.ts
│   ├── permissions.ts
│   ├── personas.ts
│   ├── project.ts
│   ├── prompt.ts
│   ├── readline.ts
│   ├── rules.ts
│   ├── runner.ts
│   ├── session.ts
│   ├── settings.ts
│   ├── skills.ts
│   ├── startup.ts
│   ├── tools.ts
│   ├── upgrade.ts
│   └── vendors.ts
│
├── ui/             # All UI components (React/Ink)
│   ├── App.tsx
│   ├── ChatLog.tsx
│   ├── Composer.tsx
│   ├── Spinner.tsx
│   ├── commands.ts
│   ├── gradient.ts
│   ├── pickerBridge.ts
│   ├── readClipboardImage.ts
│   ├── tui.tsx
│   ├── useAgentSession.ts
│   └── input/
│       ├── input-parser.ts
│       ├── keybindings.ts
│       ├── keys.ts
│       ├── stdin-buffer.ts
│       ├── textarea.ts
│       └── word-nav.ts
│
├── pickers/        # Shared picker interfaces + implementations
│   ├── domain.ts   # Business logic (model/session selection)
│   ├── ink.tsx     # Ink-based pickers for TUI
│   ├── readline.ts # Readline-based pickers for --basic
│   └── types.ts    # Shared interfaces
│
└── index.ts        # Main entry point
```

## Tasks

- [x] 1. Create `core/` directory
- [x] 2. Move core files to `core/`
- [x] 3. Move `tui.tsx` into `ui/`
- [x] 4. Update PROMPTS_DIR paths in core files (loop.ts, personas.ts, skills.ts)
- [x] 5. Update all imports in core files
- [x] 6. Update all imports in ui files
- [x] 7. Update all imports in pickers files
- [x] 8. Update main `index.ts` imports
- [x] 9. Update all test imports (including dynamic `await import()`)
- [x] 10. Run biome to fix import ordering
- [x] 11. Run `npm run check` to verify types
- [x] 12. Run tests to verify functionality (266/266 pass)

## Status
- Started: 2026-07-04
- Completed: 2026-07-04
