# Summaries consent popup — design

_Date: 2026-07-13 · Branch: brown_

## Problem

When MemBridge starts, its first sync silently rewrites the `AGENTS.md` (and
`CLAUDE.md`) memory block in every discovered project. That block includes an
instruction line asking AI tools to append session summaries to
`.membridge/summaries.jsonl`. The user never consents to this — it just
happens, on both the app and the CLI. The Claude Code Stop hook is the only
summary mechanism that requires an explicit action (`membridge setup-hooks`).

This is app-first product: the app must ask before it edits the user's files.

## Goal

A first-run popup in the desktop app that requests permission before MemBridge
asks AI tools to write summaries. The answer is remembered. The recent-activity
memory block keeps injecting regardless — only the summary-*writing* mechanisms
are gated.

Out of scope (tracked for follow-up passes): full app/CLI parity (scan view,
remove, hooks toggle UI, team revoke-invite, distillation controls). See the
Parity gap list at the end.

## Decisions

- **Popup surface:** native Electron dialog shown by the tray app on first run.
- **What it gates:** only the summary-writing instruction line + the Claude Code
  Stop hook. The recent-activity block still auto-injects (core value).
- **What "Enable" does:** turns summaries on for every tool at once — keeps the
  AGENTS.md summary line active AND installs the Claude Code Stop hook.
- **What "Not now" does:** MemBridge stays hands-off on summaries — no summary
  line, no hook. Remembered so the popup does not reappear.
- **CLI:** unaffected. No popup. `membridge setup-hooks` still works and records
  consent as granted.

## Consent state model

Add a tri-state `consent` field to the `distill` config block in `lib/util.js`:

```js
distill: { enabled: true, minEdits: 1, checkpointEvery: 4, consent: null }
//  consent: null = never asked · 'granted' · 'declined'
```

- The summary instruction line in `lib/digest.js` (currently gated on
  `config.distill.enabled !== false`) additionally requires
  `distill.consent === 'granted'`.
- Existing users upgrade with `consent` absent → treated as `null` → the line
  pauses and the popup appears once (retroactive consent). This is intended.

## Modules

### `lib/consent.js` (new, pure, fully unit-testable — no Electron)

- `needsConsentPrompt(config)` → `true` when `distill.consent == null` and
  `distill.enabled !== false`.
- `applyConsent(decision)` — `decision` is `'granted'` or `'declined'`:
  - writes `distill.consent` to user config (via `util.loadUserConfig` /
    `util.saveUserConfig`);
  - on `'granted'`, also calls `hooks.setupHooks()` (idempotent — reuses the
    existing installed-guard);
  - on `'declined'`, leaves the hook uninstalled;
  - returns a short summary of what changed.

### `lib/digest.js` (edit)

The summary-line branch (around line 279) gains the consent check:
`config.distill.enabled !== false && config.distill.consent === 'granted'`.

### `app/main.js` (edit — thin shim)

After `util.ensureConfig()`, before the first `tick()`:

- if `consent.needsConsentPrompt(config)`, show a native
  `dialog.showMessageBox` with an explanation and **Enable** / **Not now**
  buttons;
- route the click through `consent.applyConsent(...)`;
- defer the first sync until answered so nothing is written pre-consent.

The dialog wiring stays ~10 lines over the tested `consent` module. App boot is
already covered by the `--smoke` path.

### `bin/membridge.js` (minor)

`setup-hooks` records `consent: 'granted'` (so a CLI user who ran it never gets
prompted by the app later). Optionally print a one-line hint that the app offers
guided setup.

## Testing (zero-dep `test/run-tests.js` harness, temp-dir env overrides)

1. `needsConsentPrompt`: true when `consent:null`; false after granted/declined;
   false when `enabled:false`.
2. Digest render via `syncOnce`: summary line **absent** with `consent:null`,
   **present** after `applyConsent('granted')`, **absent** after `'declined'`.
3. `applyConsent('granted')` installs the Stop hook into the mock
   `MEMBRIDGE_CLAUDE_SETTINGS`; `'declined'` does not.
4. Idempotency: granting twice does not duplicate the hook.
5. Migration: config with no `consent` key behaves as `null` (prompt shown).

## Parity gap list (deliverable for follow-up passes)

CLI commands with no app/dashboard equivalent today:
- `scan` — read-only discovery view.
- `remove` — strip injected memory blocks per project.
- `setup-hooks` / `remove-hooks` — Claude Code hook toggle (partly addressed by
  this popup; a persistent toggle in Settings still missing).
- `team revoke-invite` — no dashboard control.
- distillation controls (`minEdits`, `checkpointEvery`, enable/disable) — only
  editable via raw settings JSON.
