# Plan Mode — Design Document

**Status:** Implemented  
**Created:** 2026-07-11  
**Last updated:** 2026-07-11

---

## Overview

Plan mode is a restricted agent state where the model can explore the codebase and produce a structured plan, but cannot execute code, write files, or run shell commands. It forces a "think before you act" workflow: research → clarify → plan → approve → implement.

## Goals

1. Prevent premature code writing on complex tasks
2. Save LLM tokens by catching wrong approaches before implementation
3. Give the user a chance to course-correct before any file is touched
4. Produce a reusable plan artifact that survives compaction

## Non-goals

- Automatic plan mode detection (no heuristic "is this complex enough?")
- Plan templates or enforced structure (the model decides the format)
- Plan versioning or branching

---

## UX

### Entry

Two ways in:

1. User types `/plan`. The command only enters the mode — the task description is sent as a regular message afterwards. Running `/plan` while already in plan mode shows `[Already in plan mode]` and changes nothing.
2. The model suggests it: in build mode the `plan_enter` tool signals "this task is worth planning first" with a reason. When the turn ends, the user gets a Yes/No dialog; on Yes the mode switches and a synthetic user message auto-starts the planning turn. On No, `[Staying in build mode]` and a synthetic "plan mode declined — proceed directly" message resumes the task — the model ended its turn waiting for the decision, so declining must not leave the session hanging in silence.

Behavior:
- Sets `planMode = true`
- Injects plan-mode system prompt block
- Restricts tool set via `disabledTools`
- Shows notice: `[Plan mode: ON — exploring and planning only]`

### Exit — the approval flow

The full lifecycle: `plan_done` signals the plan is ready → when the turn ends, the user gets an approval dialog:

1. **Approve — switch to build and implement now**: mode flips to build and a synthetic user message auto-starts the implementation. The auto-submit is deferred until the render that applied the mode flip, so the run picks up the fresh tool set (not the pre-flip closures).
2. **Approve — clear context, then implement**: same, but the planning conversation is dropped first. Safe because of the mirror block — the plan is re-read from disk into the system prompt, so the exploration chatter goes without losing the decisions. The right choice after a long planning session.
3. **Approve — switch to build, I'll start myself**: mode flips, the user types the starting message (the natural place for "go, but change step 3").
4. **Keep planning — I'll give feedback**: nothing changes; the user describes what to refine.

Dialogs open only when the run settles, never mid-run — the mode always flips between runs, so tool sets stay consistent. Signals that arrive after the user already toggled the mode manually are dropped.

`/build` remains as the manual approval gesture with the same semantics: from the moment the mode flips, as long as the session has a plan, the build-mode mirror block keeps injecting it, so any next message starts implementation guided by the plan. Running `/build` outside plan mode shows `[Not in plan mode]`.

Plan mode is per-task session state: `/new` and switching sessions via `/sessions` always reset it to build mode.

### Per-phase model

Planning can run on a different model than building: `/plan-model` picks a model used only while plan mode is active (`/plan-model <id>` sets it directly, `/plan-model off` clears it). Stored in `settings.json` (`planModel`), like `subagentModel`. The typical split: a strong expensive model for planning, a cheap one for building, a fast one for subagents.

- `session.model` stays the main model — the override is a per-phase substitution at run time, applied the moment plan mode turns on (including the `plan_enter` auto-started turn) and dropped on `/build`.
- Everything downstream reports the model actually in use: the status bar, the `Model:` line in the system prompt, and the run itself.
- Unset → plan mode uses the main model, exactly as before.

### Persistence

The mode is stored **per session** (`SessionState.mode`) and restored when that session is resumed — quitting mid-planning comes back to plan mode in that session, without leaking it into other projects (the original global `settings.mode` did exactly that and was retired). Unset means "build": **build is the default mode**. Every transition persists via the single `setPlanMode` setter; `/new` starts fresh sessions in build, `/sessions` restores whatever mode the chosen session was left in.

Mode switching is rejected while a run is active (`[Agent running — finish the run or /abort before switching modes]`): a run captures its tool set and system prompt at start, and flipping the mode under it would leave the prompt claiming one thing while the executor gate enforces another.

### UI indicators

- The mode is always visible in the status line right after the persona label: `[PLAN]` in warning color (it changes what the agent may do), `[BUILD]` muted
- Plan mode ON/OFF shown as a notice (temporary banner, not a persistent message)
- On a successful `plan_done`, a persistent `[Plan ready — review it, then /build to approve and implement]` message is appended to the transcript (not a timed notice — it must survive while the user reads the plan)

### /help update

```
  /plan                Enter plan mode (explore + plan only)
  /build               Exit plan mode, restore full toolset
```

---

## Tool restrictions

### Mechanism

Uses the existing `disabledTools: Set<string>` mechanism — tools are filtered from definitions sent to the API, so the model physically cannot call them. This is a hard restriction, not prompt-level guidance.

The same set also gates execution: the loop's `executeTool` wrapper refuses any call whose name is in `disabledTools`, so a fabricated call to a non-advertised tool (bash in plan mode, `plan_*` in build mode) returns an error instead of running — the same principle as the existing `task` executor gate.

Headless runs (`cast run`) have no plan mode: `run.ts` adds all `PLAN_TOOL_NAMES` to `disabledTools`, so the plan tools are neither advertised nor executable there. But an approved plan still steers: run.ts passes a build-mode `planState`, so resuming a session that has one (`cast run -c "..."`) injects the same mirror block as the TUI.

### Plan mode tool matrix

| Tool | Plan mode | Build mode | Notes |
|---|---|---|---|
| `read` | yes | yes | |
| `find` | yes | yes | |
| `grep` | yes | yes | |
| `ls` | yes | yes | |
| `web_search` | **toggle** | toggle | Respects `/web` toggle. If user disabled web tools, they stay disabled in plan mode. |
| `web_fetch` | **toggle** | toggle | Same as web_search. |
| `task` | yes | yes | Available but inherits restricted `disabledTools`. Subagent cannot call bash/write/edit either. |
| `bash` | **read-only** | yes | Executor-enforced allowlist in plan mode: pipelines of inspection binaries (ls, cat, grep, find, wc, diff, jq, git log/show/diff/status/blame, …) pass; redirects, command/process substitution, unlisted binaries (incl. test runners, package managers, `env` — all can run arbitrary code) are rejected with the reason. Argument-level writers on allowlisted binaries are also caught: `find -delete/-exec`, `fd -x`, `sort -o`, `tree -o`, `--output`, `uniq in out`. |
| `write` | **no** | yes | Blocked — cannot write files |
| `edit` | **no** | yes | Blocked — cannot edit files |
| `plan_write` | **yes** | no | New. Write or replace a named plan; it becomes the active one. |
| `plan_edit` | **yes** | no | New. Edit specific section of the active plan by heading match. |
| `plan_read` | **yes** | **yes** | New. Read a plan + list the session's plans. Switches the active plan only in plan mode; reference-only in build. |
| `plan_done` | **yes** | no | New. Signal plan completion, prompt user to switch to build. |
| `plan_check` | no | **yes** | New. Mark a plan checklist item done. Build-mode-only: the approved plan can't be rewritten during implementation, only checked off. |
| `plan_enter` | no | **yes** | New. Model suggests planning first; user confirms via dialog at turn end. |
| `plan_discard` | **yes** | no | New. Delete an abandoned draft; if it was active, the newest remaining plan takes over. |

### disabledTools construction (App.tsx)

```ts
const disabledTools = useMemo(() => {
  const s = new Set<string>();
  // Web tools respect the user's toggle in BOTH modes
  if (!webToolsEnabled) {
    s.add("web_search");
    s.add("web_fetch");
  }
  if (planMode) {
    // Hard block write-capable tools
    s.add("bash");
    s.add("write");
    s.add("edit");
    // plan_* tools only available in plan mode (not in build)
    // — handled by tool definitions, not disabledTools
  } else {
    // plan_* tools only available in plan mode
    s.add("plan_write");
    s.add("plan_edit");
    s.add("plan_read");
    s.add("plan_done");
  }
  return s;
}, [webToolsEnabled, planMode]);
```

### Subagent inheritance

Subagents inherit the parent's restrictions plus the plan tools (task.ts):
```ts
disabledTools: new Set([...(deps.disabledTools ?? []), ...PLAN_TOOL_NAMES]),
```

A subagent spawned in plan mode gets the same restricted set — it can read files and produce findings, but cannot write anything; bash is blocked entirely for plan-mode subagents (the read-only allowlist is a main-agent affordance). Plan tools are never available to subagents: they explore and report back; the parent owns the plan file.

Plan handoff: the parent's `planState` is passed to the child with `enabled: false`, so a build-mode subagent delegated an implementation step sees the same approved-plan mirror block as the parent (and a plan-mode subagent sees the current draft) instead of working blind.

---

## Plan tools

### The active plan

A session can hold several named plans. The tools operate on the **active** plan: the one most recently written via `plan_write` or read via `plan_read`. After an app restart (session resume) that in-memory marker is gone, so the newest `.md` file in the session's plans directory becomes the active plan.

Switching between plans: `plan_read` with a `name` reads that plan and — in plan mode — makes it active, the way to refine one of several plans without rewriting it. `plan_write` with an existing name replaces that plan and makes it active. In build mode `plan_read` is reference-only: the approved plan keeps steering the implementation (swapping it mid-build would bypass the `/build` approval); `plan_check` can still target any plan explicitly via its `plan` parameter.

### `plan_write`

Write or replace a named plan.

```ts
{
  name: "plan_write",
  description: "Write or replace a named plan file; the plan just written becomes the active one for plan_edit/plan_read/plan_done. Use markdown with sections: Context, Steps, Verification.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short descriptive kebab-case name for the plan, e.g. 'auth-refactor'" },
      content: { type: "string", description: "Full plan markdown content" }
    },
    required: ["name", "content"]
  }
}
```

Behavior:
- The model supplies the name; it is slugified (lowercase kebab-case, path-traversal safe: `../evil` → `evil`), empty-after-slug names are rejected
- Creates `~/.cast/plans/<session-id>/` directory if missing
- Writes to `~/.cast/plans/<session-id>/<name>.md`
- Atomic write (temp + rename, same pattern as sessions)
- Returns: `{ success: true, name, path, charCount }`

### `plan_edit`

Edit a section of the plan by heading match. Avoids rewriting the full plan for small changes.

```ts
{
  name: "plan_edit",
  description: "Edit a section of the plan by matching its heading. Replaces the section content.",
  parameters: {
    type: "object",
    properties: {
      heading: { type: "string", description: "Section heading to match (substring match, case-insensitive)" },
      content: { type: "string", description: "New content for that section (heading is preserved)" }
    },
    required: ["heading", "content"]
  }
}
```

Behavior:
- Reads the active plan, finds the section under the matched heading
- Matching is case-insensitive; an exact heading match wins over substring, so "Steps" edits "Steps" even when "Next Steps" also exists
- If the substring matches multiple sections: returns error listing the matching headings
- Heading-like lines inside fenced code blocks are ignored — a `# comment` in a bash snippet is not a section boundary
- Replaces section body (everything from heading to next same-or-higher-level heading)
- Returns: `{ success: true, plan, section: "Steps", charCount }`
- If heading not found: returns error with current headings list
- If no plan exists: returns error telling agent to use plan_write first

### `plan_read`

Read a plan (active by default, or by name) and list the session's plans.

```ts
{
  name: "plan_read",
  description: "Read a plan's content and headings, plus the names of all plans in this session. The plan read becomes the active one for plan_edit/plan_done — use `name` to switch between plans.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Plan name to read (omit for the currently active plan)" }
    }
  }
}
```

Behavior:
- Returns the plan's name, content, headings, and char count
- In plan mode the plan read becomes the active one; in build mode reading never switches the active plan
- With `name`: reads that specific plan (slugified first); unknown name → error listing available plans
- Always includes `plans`: the names of every plan in the session directory
- `{ exists: false, plans: [...] }` when no plan yet

### `plan_done`

Signal that the plan is complete and ready for review.

```ts
{
  name: "plan_done",
  description: "Signal that the plan is complete. Shows the plan to the user for approval.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "One-line summary of what the plan covers" }
    }
  }
}
```

Behavior:
- Reads the active plan and returns it (name included) with a `planReady: true` signal
- The UI appends a persistent `[Plan ready — review it, then /build to approve and implement]` message to the transcript
- Mode switching stays a user decision — `/build` is never triggered automatically
- If no plan file exists → error

### `plan_discard`

Delete a plan from the session — the exit for abandoned drafts, which would otherwise linger in the mirror's "other plans" line forever (and could even become active again via the mtime fallback after a resume). Plan-mode-only, like the other authoring tools.

```ts
{
  name: "plan_discard",
  description: "Delete a plan from this session (e.g. an abandoned draft the user asked to drop). If it was the active plan, the newest remaining one becomes active.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the plan to discard" }
    },
    required: ["name"]
  }
}
```

Behavior:
- Name is slugified (traversal-safe); unknown name → error listing the session's plans
- Deleting the active plan clears the marker; the newest remaining plan resolves as active
- Returns `{ success: true, discarded, plans, active }`

### `plan_enter`

Suggest switching to plan mode — the model's counterpart of the user's `/plan`. Build-mode-only.

```ts
{
  name: "plan_enter",
  description: "Suggest switching to plan mode when the user's request is complex enough to benefit from planning before implementation (multiple files, architectural decisions, unclear scope). The user is asked to confirm — call this, then END YOUR TURN and wait. Do not call it for simple, direct tasks.",
  parameters: {
    type: "object",
    properties: {
      reason: { type: "string", description: "One sentence on why this task benefits from planning first" }
    },
    required: ["reason"]
  }
}
```

Behavior:
- Pure signal: returns `{ planSuggested: true, reason, note }` telling the model to end its turn; it cannot block on the user mid-run
- When the run settles, the UI shows a Yes/No dialog; Yes → plan mode + auto-started planning turn, No → `[Staying in build mode]`
- The build-mode `Mode:` line in the system prompt points the model at this tool for complex tasks

### `plan_check`

Mark a checklist item in the approved plan as done. Available in build mode — progress tracking is an implementation act, and it deliberately can't rewrite the plan, only flip `- [ ]` → `- [x]`.

```ts
{
  name: "plan_check",
  description: "Mark a checklist item in the approved plan as done ('- [ ]' → '- [x]'). Call it right after completing each plan step.",
  parameters: {
    type: "object",
    properties: {
      item: { type: "string", description: "Text of the checklist item (case-insensitive; exact match wins over substring)" },
      plan: { type: "string", description: "Plan name to check the item off in (omit for the active plan)" }
    },
    required: ["item"]
  }
}
```

Behavior:
- Finds an unchecked `- [ ]` line by item text (same matching contract as plan_edit: case-insensitive, exact wins over substring, ambiguity → error listing candidates)
- Fence-aware, like the section parser and the checklist counter: a checkbox-like line inside a code example is content, never a candidate — matching it would corrupt the example (and a fenced `- [ ]` would keep the plan "unfinished" forever in the done-variant check)
- Targets the active plan by default; `plan` selects another session plan explicitly (unknown name → error listing plans). Targeting never changes which plan is active
- Flips it to `- [x]` and writes the file; already-checked items are never candidates
- Returns `{ success: true, plan, item, remaining }`, plus `allDone: true` when the last item is checked
- The build-mode mirror block re-reads the plan every request, so checked-off progress automatically flows into the system prompt — after compaction the model still sees exactly where it stopped
- No plan / no unchecked items / no match → error

---

## System prompt injection

When plan mode is active, a block is prepended to the system prompt. The block is content, not code — it lives in `prompts/modes/plan-mode.md` (loaded via `readRequiredPrompt`, same as the compaction prompts). Beyond the tool restrictions, it carries the planning methodology:

- **Execution spec, not design doc**: the bar is an executor who never saw the conversation performing the file top to bottom with zero decisions of substance left; completeness beats brevity when they collide
- **Workflow**: RE-ENTRY (plan_read first — an existing plan for the same task is updated, not duplicated; a different task gets a fresh name; plan_discard drops abandoned drafts on request) → UNDERSTAND (restate the ask, read the material, parallel focused `task` subagents when scope spans areas) → GROUND (unknowns eliminated by reading, not asking; unverified claims marked inline; user asked only about preferences/tradeoffs, batched, 2-4 options with a recommended default) → WRITE (plan_write early, plan_edit as findings land — never batched to the end) → DONE (self-check, plan_done, end turn)
- **Plan structure**: Context (literal ask + end state, every outcome maps to a step) / Steps (ordered `- [ ]` checklist; concrete verb + exact target + new state; names material to reuse; grouped by outcome; edge handling stated) / Verification (commands + expected output for executable work, review criteria otherwise; at least one check exercises the NEW behavior) / Assumptions (only overridable decisions, each with a pre-decided fallback)
- **Anti-padding directives**: no decision-free sections (Non-Goals, Alternatives, Risks), no references to the planning conversation

The block is deliberately domain-neutral — "material", "files", "changes" rather than "code". Personas repurpose the harness for prose, marketing copy, or schema work (fiction-writer, marketer, dba…), and the same methodology holds: for a manuscript, Steps name chapters and scenes, and Verification is read-through criteria instead of commands.

### Placement in system prompt assembly

The plan block is prepended to the entire system prompt (persona included), so it is the very first thing the model sees. It is re-applied on every request via `syncSystemPrompt`, which means toggling the mode mid-run takes effect on the next request within the same run.

Ordering matters: the block is applied AFTER `rebuildSystemPrompt` — the per-turn rebuild path (always active in the TUI) replaces the prompt wholesale and would silently drop a block added before it. A loop test guards this ordering.

The plan tool descriptions carry no "only available in plan mode" boilerplate: the tools are filtered out of the definitions everywhere plan mode isn't active, so the model only ever sees them when they are callable.

### Build-mode mirror block

Once plan mode is exited and the session has at least one plan, the mirror block from `prompts/modes/build-mode.md` is APPENDED to the system prompt (guidance, not restriction — the persona keeps its place at the top), with `{{PLAN}}` replaced by the active plan's content.

The plan is snapshotted **once per run**, not per request: re-reading on every request meant each `plan_check` rewrote the system prompt mid-run and invalidated the provider's prompt cache for the entire conversation. Mode toggles are rejected while a run is active, so the snapshot loses nothing; the next submit picks up fresh checkbox state from disk.

Once every checklist item is checked, the full mirror is replaced by the one-line reference from `prompts/modes/build-mode-done.md` — a fully executed plan stops steering (and stops costing tokens); the file stays on disk for reference.

When the session holds more than one plan, both mirror variants append a line naming the others (`Other plans in this session: backend, frontend — use plan_read with a name to view one`) — the mirror carries only the approved plan, and without this line the model has no way to know the rest exist.

Compaction is plan-aware: while plan mode is active, `prompts/modes/plan-compaction.md` is appended to the summarization prompt (automatic and `/compact` both), instructing it to preserve exploration findings not yet written into the plan file and not to restate the plan's own content.

- The plan is re-read from disk on every request, which is what makes it survive compaction and session resume — `plan_read` is disabled in build mode, so without this the plan would silently vanish from context after the first compaction.
- It instructs the model to follow the plan step by step, flag divergences instead of silently drifting, and run the plan's Verification section when done.
- No plan file → no block: sessions that never used plan mode are unaffected.

---

## Plan file

### Location

`~/.cast/plans/<session-id>/<name>.md`

- One directory per session, several named plans per directory
- The name comes from the model via `plan_write` and is slugified before hitting the filesystem
- Survives session resume (`--continue` / `--resume`) — the newest plan in the directory becomes active
- Created on first `plan_write` call, not on mode entry

### Format

The model decides the structure. Suggested template (in tool description, not enforced):

```markdown
# Plan: <title>

## Context
<what was explored, relevant files, current architecture>

## Steps
1. <step> — <files to change>
2. <step> — <files to change>

## Verification
<how to test: commands, expected behavior>
```

### Lifecycle

- Created: first `plan_write` call
- Updated: subsequent `plan_write` or `plan_edit` calls
- Read: `plan_read` call or agent needs to reference it
- Consumed: user switches to `/build` — the plan is injected into the build-mode system prompt on every request (see "Build-mode mirror block")
- Persisted: survives across sessions (plan file is independent of session JSON)

---

## Implementation plan

### Files created

| File | Purpose | Lines |
|---|---|---|
| `src/core/plan.ts` | Plan state type, plan file I/O, tool executors | 220 |
| `test/plan.test.ts` | Tests for plan tools and plan file operations | 165 |

### Files modified

| File | Change | Lines changed |
|---|---|---|
| `src/ui/App.tsx` | `planMode` state, `planState`, expanded `disabledTools`, pass to deps | +25 |
| `src/ui/commands.ts` | `/plan`, `/build` slash commands, `CommandDeps` extended | +35 |
| `src/core/tools.ts` | 4 plan tool definitions, plan executor dispatch | +60 |
| `src/core/loop.ts` | `planState` in `LoopConfig`, plan system prompt injection | +25 |
| `src/ui/useAgentSession.ts` | `planState` param threading | +5 |

### Total

~220 new lines, ~150 changed lines. Zero new dependencies.

---

## Verification

All checks pass:
- `npm run check` — tsc + biome clean
- `npm test` — 571 tests pass (14 new plan tests)
- `npm run build` — bundles successfully

Manual verification:
1. `/plan` enters plan mode — `bash`, `write`, `edit` not in tool definitions
2. `/build` exits plan mode — full toolset restored
3. Agent can `read` files in plan mode
4. Agent can call `plan_write` to create a plan
5. Agent can call `plan_edit` to update a section
6. Agent can call `plan_done` to signal completion
7. `task` works in plan mode, subagent inherits restricted tools
8. Web tools respect toggle in plan mode
9. Plan file persists across session resume

---

## Change log

| Date | Change |
|---|---|
| 2026-07-11 | Initial design |
| 2026-07-11 | Implementation complete — all tools, commands, tests, docs |
