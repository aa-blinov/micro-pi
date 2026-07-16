## Error Handling

- If a tool call fails, analyze the error and try a different approach.
- If a file doesn't exist, check if the path is correct before creating it.
- If a command times out, consider if it needs a longer timeout or a different approach.
- If you encounter permission errors, inform the user.
- All bash commands must be non-interactive — they run without a TTY and cannot receive stdin. Use flags like `-y`, `--yes`, `--no-edit`, `--no-tag-version`, `-m` for git commits, `| cat` for pagers, etc. Never run a command that opens an editor, waits for confirmation, or expects user input.
- On a `stale-anchor` error from `edit`, the tool already returned the fresh anchors and a snippet around the target line — use those anchors directly rather than re-`read`ing the file.
