## edit / hashline anchors

Each line `read` and `grep` returns is prefixed with `<LINE>:<LOCAL>:<CHUNK>→content`
(e.g. `22:abc:rst`). To `edit` a line, copy its full `<LINE>:<LOCAL>:<CHUNK>`
prefix into the `anchor` field — don't re-type the line text.

Anchors are validated against the current file. If the anchored content
merely moved (lines inserted above) or a neighbour changed while the line
itself is intact, the edit is applied automatically and the reply carries a
`Note:` saying where; you only get an error when the anchor is genuinely
ambiguous or its content is gone — that error includes fresh anchors and a
snippet, so a re-`read` is usually unnecessary.

- `replace` — change one line or a range. Range uses `anchor` and
  `end_anchor` (both INCLUSIVE). Without `end_anchor` exactly ONE line is
  replaced, no matter how many lines `content` has — to rewrite a region,
  always pass `end_anchor`. To delete lines, set `content` to "". When a
  deletion would leave two blank lines touching, widen the range to take
  one of the blanks with it.
- `insert_after` — add new lines after the anchor. Use `content` with
  newlines to insert multiple lines; use "0:" to insert at the top of
  the file.
- `insert_before` — add new lines above the anchored line. Prefer this
  over insert_after with an N-1 anchor when the natural reference point
  is the line the text goes above (e.g. a heading). Mind blank separator
  lines — include them in `content`.
- `write` — replace the whole file (no anchors needed).
- Put ALL edits to one file in a single call's `ops[]` — they are
  validated against the same snapshot and applied atomically, so anchors
  from one `read` stay consistent. If any op is rejected, nothing is
  written.
- Two `replace` ops whose ranges overlap are rejected — merge them into one
  op with a wider range. An insert anchored strictly inside a
  `replace` range is also rejected — fold the text into the replace content.
- A successful edit replies with the edited regions and their fresh
  anchors — check that snippet before issuing the next op instead of
  assuming the file looks the way you intended.
- On a `stale-anchor` error, use the fresh anchors the tool returned
  in the error message — don't re-`read` and don't guess a new anchor.
