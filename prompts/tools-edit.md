## edit / hashline anchors

Each line `read` and `grep` returns is prefixed with `<LINE>:<HASH>→content`
(`<LINE>:<HASH>:<HH>→content` for the small fraction of lines where the
secondary hash disambiguates). To `edit` a line, copy its `<LINE>:<HASH>`
prefix into the `anchor` field — don't re-type the line text. Matches are
byte-exact against the current file; on a mismatch the tool replies with
fresh anchors and a snippet you can use to retry, so a re-`read` is
usually unnecessary.

- `replace` — change one line or a range. Range uses `anchor` and
  `end_anchor` (both INCLUSIVE). To delete lines, set `content` to "".
- `insert_after` — add new lines after the anchor. Use `content` with
  newlines to insert multiple lines; use "0:" to insert at the top of
  the file.
- `write` — replace the whole file (no anchors needed).
- Multiple ops in one call are validated against the pre-edit file and
  applied atomically; if any anchor is stale, the whole batch is rejected.
- Two `replace` ops whose ranges overlap are rejected — merge them into one
  op with a wider range.
- On a `stale-anchor` error, prefer the fresh anchors the tool returned
  over guessing a new `oldText`; the tool already computed them for you.
