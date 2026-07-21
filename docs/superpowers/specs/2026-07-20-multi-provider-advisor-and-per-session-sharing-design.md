# Multi-Provider Advisor & Per-Session Prompt Sharing

**Date:** 2026-07-20
**Status:** Approved design
**Builds on:** the BYOK advisor ([lib/advisor.js](../../lib/advisor.js), PLAN M2/M3) and team sync's prompt gate ([lib/teamsync.js](../../lib/teamsync.js) `pushProject`, `encryptRow`). Interacts with the E2E crypto model ([2026-07-17-e2e-encryption-client-design.md](2026-07-17-e2e-encryption-client-design.md)) and the runs/threads feed model ([2026-07-16-session-runs-and-threads-design.md](2026-07-16-session-runs-and-threads-design.md)).

Two independent features, shipped together because they share a home (Settings + the team feed) and both turn a hard-coded, all-or-nothing choice into user control.

---

## Feature 1 — Multi-provider advisor

### Problem

MemBridge's only self-made LLM calls are the **catch-up briefing** (summarizes teammate activity) and the **roadmap planner**, both in `lib/advisor.js`. They are hard-wired to `api.anthropic.com` with a Claude-only model dropdown (`PLANNER_MODELS`) and a single Anthropic key. A user who prefers OpenAI, Gemini, or a local model cannot use these features.

Out of scope: the in-session "Did/headline" session summaries — those are written by whatever coding tool ran the session (Claude Code, Codex, …) via the Stop hook, not by MemBridge, so they are already multi-vendor and have no MemBridge-side model setting.

### Goal

Let the user pick the **provider** (Anthropic, OpenAI, Gemini, or a local / OpenAI-compatible endpoint) and a **model** for the advisor, storing a per-provider key, with the briefing and roadmap both routed to the chosen provider.

### Approach — provider-adapter registry

New `lib/advisors/` directory, one small file per provider implementing a common interface. `advisor.js` becomes the orchestrator: it selects an adapter and keeps its existing public surface (`generatePlan`, `generateBriefing`, `testKey`, `estimateCost`, `getAdvisorConfig`) so `server.js` callers change minimally.

Rejected alternatives:
- **One big `advisor.js` with per-provider `switch`es** — the file is already 312 lines; per-provider branching in every function would balloon it and bury the shared orchestration. Fails the many-small-files / high-cohesion rule.
- **Vendor SDKs** (`@anthropic-ai/sdk`, `openai`, `@google/genai`) — MemBridge is deliberately zero-dependency raw `fetch`. Three SDKs contradict that and bloat install. We stay on `fetch`.

### Adapter interface

Each adapter (~150–250 lines) exports:

```js
{
  id,                 // 'anthropic' | 'openai' | 'google' | 'local'
  label,              // 'Anthropic (Claude)', 'OpenAI (GPT)', …
  needsBaseUrl,       // true only for 'local'
  keyEnv,             // env-var fallbacks, e.g. ['OPENAI_API_KEY']
  models,             // curated catalog: [{ id, label, priceIn, priceOut }]
  async testKey({ apiKey, baseUrl }),        // cheapest liveness probe → { ok } | { ok:false, error }
  async generate({ apiKey, baseUrl, model, system, prompt, schema, maxTokens, signal }),
      // schema present ⇒ structured JSON required; schema null ⇒ free-form text.
      // Returns { text, usage } | { error } (never throws for expected failures).
}
```

Files:
- `lib/advisors/anthropic.js` — ports today's request/response code (`output_config.json_schema`, `count_tokens` probe, `thinking:{disabled}` for Sonnet).
- `lib/advisors/openai.js` — Chat Completions with `response_format:{ type:'json_schema', json_schema:{ schema, strict:true } }`; `GET /v1/models` probe.
- `lib/advisors/google.js` — `generationConfig.responseMimeType:'application/json'` + `responseSchema`; `GET /v1/models` probe.
- `lib/advisors/openai-compatible.js` — generic OpenAI-shaped `POST {baseUrl}/chat/completions`; used for local (Ollama/LM Studio/OpenRouter). Attempts `response_format` but does **not** assume schema adherence (see below). Probe: `GET {baseUrl}/models`, else a tiny completion.
- `lib/advisors/index.js` — registry (`byId`, `list`) and the shared normalized error shapes.

### Cross-vendor translation (the one real wrinkle)

- **Briefing** is free-form prose → trivial for every adapter (`schema:null`).
- **Roadmap** requires guaranteed-parseable JSON matching `PLAN_SCHEMA`. Each provider expresses this differently (list above). The **local / OpenAI-compatible** adapter cannot assume the endpoint honors `response_format`; it therefore also embeds the schema in the system prompt and runs a **tolerant parse**: try `JSON.parse`, else extract the first balanced `{…}` object, else return the standard "answered with something unreadable — try again" error. `advisor.js` only ever sees `{ text, usage }` and parses `text` as it does today.
- **Liveness / test-key**: Anthropic keeps `count_tokens` (free); OpenAI/Gemini use a cheap `GET /models`; local pings `{baseUrl}/models`.
- **Cost**: each adapter carries its own `[priceIn, priceOut]` per model; `estimateCost`/`actualCost` move behind the adapter (or read its `models` table). Local reports **no cost estimate** (unknown pricing) — the UI shows "—" rather than a fake number.
- **Usage normalization**: adapters map their native usage object to `{ input_tokens, output_tokens, cache_* }` so `actualCost` stays provider-agnostic.

### Config shape

```jsonc
advisor: {
  provider: 'anthropic',              // selected provider id
  model: 'claude-haiku-4-5',          // model id valid for the selected provider
  providers: {
    anthropic: { apiKey: '…' },
    openai:    { apiKey: '…' },
    google:    { apiKey: '…' },
    local:     { baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3.1' }
  }
}
```

**Back-compat migration (lazy, non-destructive):** if legacy `advisor.apiKey` / `advisor.model` exist and `advisor.providers` does not, read them as `providers.anthropic.apiKey` and top-level `model`, with `provider` defaulting to `'anthropic'`. `getAdvisorConfig(config)` performs this read-time shim; it does not rewrite the file until the next settings save. Env fallbacks: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY` per adapter `keyEnv`.

**Curated vs local:** the curated model dropdown governs the three cloud providers. **Local** intrinsically needs a base-URL + model-id text field (no catalog to enumerate) — this is by design, confirmed with the user, not a curated-list violation.

### Server & Settings UI

- `GET /api/advisor` returns `{ provider, model, providers:[{id,label,needsBaseUrl,models,keySet,baseUrl?}] }`. **Key values are never returned** — only `keySet:boolean` (and `baseUrl` for local, which is not a secret).
- `POST /api/advisor` accepts `{ provider?, model?, apiKey?, baseUrl? }`, validating `model` against the selected provider's catalog (local: any non-empty id). Writes into `advisor.providers[provider]` and the top-level `provider`/`model`.
- `POST /api/advisor/test-key` takes `{ provider }`, resolves that provider's key/baseUrl, calls the adapter's `testKey`.
- Settings screen: a provider selector; choosing one reveals that provider's key field (+ base-URL for local), its model dropdown with cost hints, and a Test button. Copy that currently says "Anthropic key" becomes provider-aware.
- `generatePlan` / `generateBriefing` in `server.js` route through `advisor` to the selected provider; the "Add your … key in Settings first" guard names the selected provider.

---

## Feature 2 — Per-session prompt sharing

### Problem

Verbatim prompts (`ask`/`goal`) are the most sensitive field in an entry. Today a single global flag `config.team.sharePrompts` (default off, no UI — it's a raw config key) decides whether *every* prompt leaves the machine. When off, teammates see **"(prompt not shared)"** on every card, with no way to share an individual chat.

### Goal

A **per-session** toggle, shown on the user's own feed cards, that shares (or hides) that session's verbatim prompt from the team. Default **off**; manual opt-in per session; symmetric — turning it on **backfills** already-synced rows so teammates retroactively see the prompt, turning it off **scrubs** them back to null.

Scope of "share": the verbatim prompt only (`ask` + `goal`). Not the full conversation transcript — MemBridge does not capture transcripts today; that is a possible follow-on, out of scope here.

### Data model

`proj.sharedSessions: string[]` in each project's local memory (via `memorydb`). Absent/empty ⇒ nothing shared (the default). A tiny helper `isShared(proj, sessionId)` is the single source of truth consulted by both the push path and the reshare path. Sessions with no `session` id are never individually shareable (they render as single-entry threads and stay unshared).

### Push path change

In `pushProject` ([teamsync.js:568](../../lib/teamsync.js)), replace the global
`const share = config.team.sharePrompts === true` with **per-entry** calls to
the same `isShared` helper (so the legacy fallback below is honored in exactly
one place):

```js
// inside the row map, per entry e:
ask:  isShared(proj, e.session) ? scrub(e.ask, 400)  : null,
goal: isShared(proj, e.session) ? scrub(e.goal, 200) : null,
```

`decisions`/`gotchas`/`summary`/`files`/`changes` continue to ship regardless (they are outcome, not verbatim prompt) — unchanged.

### Reshare path (retroactive backfill + scrub)

New `teamsync.resharePromptsForSession(config, projectPath, proj, link, sessionId, share, crypto)`:

1. Build that session's entries via `memorydb.buildEntries`, filtered to `e.session === sessionId`.
2. Map to rows exactly as `pushProject` does, but force `ask`/`goal` to the scrubbed prompt (`share === true`) or `null` (`share === false`).
3. If `crypto.teamKey` is present, run each row through the existing `encryptRow` — the re-encrypted payload carries the new `ask`/`goal`, identical to a normal push. No crypto special-casing.
4. `POST memory_entries?on_conflict=project_id,author_id,ts,source` with `Prefer: resolution=merge-duplicates,return=minimal` — the **overwrite** upsert (the pattern already used at [teamsync.js:846](../../lib/teamsync.js)), so existing rows are updated in place. (Normal sync uses `ignore-duplicates`, which is why a plain re-sync can't backfill.)

This reuses the PGRST204 missing-column retry loop already in `pushProject` (extract the row-insert helper so both callers share it).

The caller (`/api/share-session`, below) also updates `proj.sharedSessions` (add on share, remove on unshare) and persists the project memory. Order: persist the flag first, then reshare; a reshare network failure surfaces as an error but the local flag already reflects intent, and the next normal sync reconciles.

### UX — toggle on the user's own card

Feed entries are marked `self:true` for the local user in [feed.js](../../lib/feed.js) (`normalizeLocal`, and `normalizeTeam` when `author_id === selfUserId`). The user always sees their own prompt locally; the toggle controls **team** visibility, so its label reads **"Visible to team" / "Hidden from team"** (not "share this prompt with myself").

- Rendered only on `self` session cards in `dashboard.js`. Teammates' cards get no toggle (you can't share on their behalf).
- The card shows the current state from `isShared(proj, session)`.
- Flipping it `POST`s to new endpoint `POST /api/share-session { project, session, share }`, which resolves the project + team link, updates `sharedSessions`, and calls `resharePromptsForSession`. On success the card re-renders with the new state; on failure it shows an inline error and reverts.
- Sessions that span multiple projects (multi-repo) toggle per project-run card, consistent with the runs model — each card carries its own `projectId`.

### Legacy migration

`config.team.sharePrompts` is retired as the model. One-time honor during a deprecation window: if a user currently has `sharePrompts === true`, treat every session as shared **unless** explicitly present-and-removed via the new per-session flag, so nobody's current sharing silently flips off. Everyone else (the default) stays off. Implemented in `isShared`: `sharedSessions` is authoritative; if it is absent entirely **and** legacy `sharePrompts === true`, fall back to shared. Once the user touches any per-session toggle, `sharedSessions` exists and legacy is ignored.

---

## Testing

Follows the repo's TDD norm (offline suite, `MEMBRIDGE_API_BASE` mock; 266+ tests today).

**Feature 1**
- Each adapter against a local mock endpoint: request-shape translation, structured-output success, and (local adapter) tolerant-parse fallback when the endpoint returns schema-free JSON or fenced text.
- `testKey` success/401/timeout per adapter.
- Cost math per provider; local reports no estimate.
- Lazy migration: legacy `advisor.apiKey`/`advisor.model` read as `providers.anthropic` with `provider:'anthropic'`; env-var fallbacks per adapter.
- `GET /api/advisor` never leaks key values (only `keySet`); `POST` validates model against the selected provider.

**Feature 2**
- `isShared`: default off; per-session set authoritative; legacy `sharePrompts:true` fallback and its override once a toggle is touched.
- `pushProject`: `ask`/`goal` null for unshared sessions, scrubbed prompt for shared; other fields unaffected.
- `resharePromptsForSession`: backfill sets prompt, scrub sets null — both plaintext **and** encrypted (payload re-encrypted with new prompt); merge-duplicates upsert used; missing-column retry reused.
- `/api/share-session`: updates `sharedSessions`, triggers reshare, error path reverts.
- Feed/render: toggle appears only on `self` cards; reflects `isShared`.

## Non-goals

- Making in-session session summaries model-selectable (they're not MemBridge-generated).
- Full conversation-transcript capture or sharing.
- A global "share by default" setting (explicitly declined — manual per session, default off).
- Rewriting existing on-disk config eagerly (migration is read-time until next save).
