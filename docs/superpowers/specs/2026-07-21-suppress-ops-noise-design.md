# Suppress Ops Noise, Distill the Substance

**Date:** 2026-07-21
**Status:** Approved (design)
**Branch:** `feat/suppress-ops-noise`

## Problem

The Activity feed and the CLAUDE.md context blocks show every captured session,
including "zero-edit" sessions that changed no files. Two very different
populations hide under that label:

- **Substantive zero-edit sessions** — diagnoses, investigations, design
  decisions, plans. No files changed, but they carry exactly the signal
  MemBridge exists to share (e.g. *"Codex prompts uncaptured because
  isGenuineRollout rejects history_mode legacy"*). These are the most valuable
  entries and must be preserved.
- **Ops-noise zero-edit sessions** — browser automation, Higgsfield ad
  generation, marketing, chrome-tab wrangling (*"try the chrome browser
  again"*, *"its in a hidden tab open it in a visible"*). Worth nothing to a
  teammate coding the project.

Today's distiller gates on `edits >= minEdits`, using "did you edit a file?" as
a proxy for "is this worth sharing." The proxy is wrong in both directions: it
excludes valuable diagnoses (0 edits) and it admits worthless browser sessions
(also 0 edits, rendered as the raw harvested last assistant message).

Measured on this machine: of 109 recent sessions, 37 had ≥1 code edit (33 of
them distilled — 89%), and **72 had zero edits** (48 of those pure harvest with
no summary). Two-thirds of recent activity is non-coding sessions rendering as
raw last-messages — which is why this machine's cards read messier than a
teammate's whose work is nearly all coding.

## Goal

The real discriminator is **substance vs. operations**, not **edits vs. no
edits**. A session that engaged with the codebase and reached a conclusion
should surface (and be distilled cleanly). A session that only drove tools
should be suppressed.

Deliver both halves:

1. **Suppress ops noise** — stop showing sessions that are neither edits nor
   substance, in the feed, the CLAUDE.md block, what we push to teammates, and
   inbound teammate data.
2. **Rescue the substance** — get substantive zero-edit sessions distilled so
   they render as a clean one-liner instead of a raw harvest.

## Non-goals

- No DB schema migration. Inbound teammate filtering reuses the existing
  `distilled` column.
- No retroactive re-distillation of already-ended sessions (impossible — the
  agent turn is gone). Noise cleanup IS retroactive; substance rescue is
  forward-only.
- No keyword/content classification of prompt text (brittle). The agent is the
  substance judge.

## Design

### The shareability predicate — `lib/classify.js` (new)

A small, pure, independently testable module. One responsibility: decide whether
a session's work is worth sharing.

```
isShareableLocal(events, sessionId)
  = sessionHasEdit(events, sessionId) || sessionHasDistilled(events, sessionId)

sessionHasEdit(events, sessionId)
  = some event with kind === 'edit' and session === sessionId

sessionHasDistilled(events, sessionId)
  = some event with kind === 'summary' and session === sessionId
    and (event.distilled || event.source === 'Distilled')

isShareableTeam(entry)
  = !!entry.distilled            // inbound rows carry no edit events
```

- **Depends on:** nothing (pure functions over event arrays).
- **Used by:** hooks, server feed assembly, digest context block, teamsync push,
  feed inbound normalization.
- **Why a separate module:** the same rule is applied in five places; a single
  source of truth prevents drift, and pure functions are trivially unit-tested.

Callers that filter many sessions should precompute a per-session shareability
map once (single pass over the project's events) rather than calling the
predicate per entry — keeps feed/block assembly O(n).

### 1. Distill trigger — `lib/hooks.js` `runStop`

Current worthiness gate:

```
const edits = <count of kind:'edit' events for this session>;
if (edits < minEdits) return;           // zero-edit sessions never distill
```

New behaviour — branch on edit count:

- `edits >= minEdits` → **unchanged.** Existing staleness-checkpoint logic
  (`checkpointEvery`) still governs edit sessions.
- `edits === 0` → **new zero-edit path:**
  - Compute `promptCount` = count of `kind:'prompt'` events for this session.
  - Floor: `distill.minPromptsZeroEdit` (default **3**). If
    `promptCount < floor` → `return` (trivial session, never nag).
  - If already summarized (`countSummaryLines(session) > 0`) → `return`
    (never block twice; the checkpoint concept does not apply to zero-edit).
  - Otherwise emit `{ decision: 'block', reason: zeroEditBlockReason(...) }`.

`zeroEditBlockReason` differs from the edit-session reason: it grants an explicit
**skip** option. Shape (final wording during implementation):

> MemBridge session distillation: if this session reached something worth
> sharing with your teammates — a diagnosis, a decision, a plan, a conclusion —
> save it by running exactly ONE command, no commentary: `<cmd> append <target>
> '<json>'`. If this session was only tool operations with nothing worth
> sharing, do nothing and stop — do not append.

The **skip path needs no new mechanism**: if the agent chooses not to append and
stops, the next Stop fires with `stop_hook_active` true, and `runStop` returns
early (never blocks twice). The session ends with no summary and is then
suppressed by the render filter below.

### 2. Render filter — feed (`lib/server.js`)

Where local entries are assembled from state (around the `normalizeLocal` push,
~L147): build a per-session shareability map for the project once, then skip
prompt events whose session is not shareable. Non-shareable local sessions never
enter `buildFeed`'s `local` array.

### 3. Render filter — context block (`lib/digest.js`)

Where per-session objects are built for `renderBlock` (~L200–221): drop sessions
where `!isShareableLocal`. The "Recent asks across tools" block then lists only
edit-or-distilled sessions.

### 4. Push filter — `lib/teamsync.js`

Where sessions/summaries are selected for push: skip non-shareable sessions so
this machine never emits ops noise to teammates.

### 5. Inbound filter — `lib/feed.js` (team path)

Drop team entries where `!isShareableTeam(entry)` (i.e. not distilled). Applied
in the team-normalization / merge path so non-distilled teammate rows never
render.

### Config

`lib/util.js` default config gains:

```
distill: {
  ...existing...
  minPromptsZeroEdit: 3      // min user prompts before a zero-edit session
                             // is worth a distill turn
}
```

## Accepted tradeoff — inbound precision

Inbound teammate filtering keys on `distilled` only, because team sync ships
summaries, not raw edit events — we cannot compute `hasEdit` for a teammate. A
teammate session that **edited files but only harvested** (no clean summary —
~11% of edit-sessions today, shrinking as distillation improves) will be hidden
on this machine even though it is real work.

The precise fix would push an `edited` boolean with each row so inbound could use
`hasEdit || distilled` to match the local rule. That requires a schema migration
plus a teammate re-push (per project history, live-Supabase migrations are
costly and coordination-heavy). **Decision:** ship distilled-only inbound now;
record the `edited` column as future work if a hidden edit-session ever bites.

## Data flow

```
Session ends
  └─ Stop hook (runStop)
       ├─ edits >= minEdits ........ block (existing checkpoint logic)
       ├─ edits == 0 && prompts>=3 . block with skip-aware reason
       │      └─ agent: append clean summary  OR  stop (skip)
       └─ else ..................... allow stop, no summary

Render / share (all use classify.js)
  ├─ feed (server.js) ....... local entries: keep iff isShareableLocal
  ├─ block (digest.js) ...... sessions: keep iff isShareableLocal
  ├─ push (teamsync.js) ..... sessions: push iff isShareableLocal
  └─ inbound (feed.js) ...... team entries: keep iff isShareableTeam (distilled)
```

## Error handling

- `runStop` already fails open (any throw → allow the stop, log). The new
  zero-edit branch stays inside that try/catch — a bad prompt count or missing
  field must never trap a session.
- The render/push/inbound filters must fail open toward **showing** on
  malformed input for local edit/distilled signals? No — they fail toward the
  safe default of the predicate: a session with no resolvable events is not
  shareable and is omitted. Filters must never throw; a defensive guard treats
  unclassifiable input as non-shareable and moves on.

## Testing (`test/run-tests.js`)

Unit — `classify.js`:
- edit session → shareable; distilled session → shareable;
  zero-edit + harvest-only → not shareable; zero-edit + no summary → not
  shareable; team entry distilled → shareable, non-distilled → not.

Unit — `runStop` zero-edit path:
- blocks when `edits==0 && prompts>=floor && no summary`; returns when
  `prompts<floor`; does not double-block when a summary already exists; edit
  sessions unaffected; the block reason contains the skip option.

Integration — filters:
- feed excludes own zero-edit harvest-only session; includes edit session;
  includes zero-edit distilled session.
- context block excludes the same; includes the same.
- teamsync push excludes non-shareable; includes shareable.
- inbound feed excludes non-distilled teammate entry; includes distilled one.

Retroactive:
- with existing state containing harvest-only zero-edit sessions, `/api/feed`
  and the rendered block no longer list them; no migration or state rewrite.

## Rollout

- Pure additive code + one config default; no migration.
- Noise suppression takes effect on first daemon pass after upgrade (filters read
  existing state).
- Substance rescue applies to sessions that end after upgrade.
- Rebuild + reinstall MemBridge.app after landing (per project convention).
