# Per-Session Prompt Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single global `config.team.sharePrompts` flag with a **per-session** share toggle on the user's own feed cards, so a "(prompt not shared)" chat can be shared (or re-hidden) with one click — symmetric: turning it on retroactively backfills already-synced rows so teammates see the prompt; turning it off scrubs them back to null.

**Architecture:** A per-project `sharedSessions: string[]` list is the single source of truth, read through one helper `isShared(config, proj, sessionId)`. The normal push path consults it per entry. A new `teamsync.reshareSession(...)` re-pushes one session's rows with PostgREST `resolution=merge-duplicates` (overwrite) — reusing the existing `encryptRow` so E2E encryption is unchanged. A `POST /api/share-session` endpoint persists the flag and calls the reshare. The feed annotates the user's own entries with `shared`, and the session card renders a "Visible to team / Hidden from team" toggle for `self` cards only.

**Tech Stack:** Node.js, zero runtime deps. Offline suite in `test/run-tests.js` against `test/mock-supabase.js`.

**Companion spec:** [../specs/2026-07-20-multi-provider-advisor-and-per-session-sharing-design.md](../specs/2026-07-20-multi-provider-advisor-and-per-session-sharing-design.md) (Feature 2).

**Legacy compatibility:** the existing `sharePrompts` tests (e.g. `test/run-tests.js:4016`, `:3445`, `:3469`) must stay green. `isShared` honors a legacy `sharePrompts === true` as "all sessions shared" whenever a project has no `sharedSessions` list yet — so pre-migration behavior is byte-identical until the user touches a toggle.

---

## File Structure

- **Modify** `lib/teamsync.js` — add `isShared`; extract `entryToRow` + `upsertEntries`; per-entry gating in `pushProject`; new `reshareSession`. Export `isShared`, `reshareSession`.
- **Modify** `lib/feed.js` — `normalizeLocal` copies a `shared` flag.
- **Modify** `lib/server.js` — `feedPayload` annotates self entries with `shared`; new `POST /api/share-session`.
- **Modify** `lib/dashboard.js` — session card toggle for `self` cards (`threadHtml`/`unitHtml`) + delegated click handler.
- **Modify** `test/mock-supabase.js` — honor `Prefer: resolution=merge-duplicates` (overwrite on conflict).
- **Modify** `test/run-tests.js` — new tests.

---

## Task 1: `isShared` helper + per-session gating in `pushProject`

**Files:**
- Modify: `lib/teamsync.js` (near `pushProject`, `lib/teamsync.js:553`)
- Test: `test/run-tests.js`

- [ ] **Step 1: Write the failing test**

```js
check('teamsync: isShared is per-session, default off, with legacy fallback', () => {
  const proj = { sharedSessions: ['s1'] };
  assert.strictEqual(teamsync.isShared({}, proj, 's1'), true);
  assert.strictEqual(teamsync.isShared({}, proj, 's2'), false);
  assert.strictEqual(teamsync.isShared({}, {}, 's1'), false);            // default off
  assert.strictEqual(teamsync.isShared({}, {}, null), false);            // no session id
  // Legacy: a project with NO sharedSessions list + old global flag on ⇒ shared.
  assert.strictEqual(teamsync.isShared({ team: { sharePrompts: true } }, {}, 's1'), true);
  // But once a list exists, the list wins and legacy is ignored.
  assert.strictEqual(teamsync.isShared({ team: { sharePrompts: true } }, { sharedSessions: [] }, 's1'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run-tests.js 2>&1 | grep "teamsync: isShared"`
Expected: FAIL — `teamsync.isShared is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add above `pushProject` in `lib/teamsync.js`:

```js
// Single source of truth for "does this session's verbatim prompt leave the
// machine?". Per-session (proj.sharedSessions), default off. Legacy honor
// window: a project that has NEVER been touched by the per-session UI (no
// sharedSessions array at all) still respects the old global config.team
// .sharePrompts flag, so pre-migration users keep their current behavior until
// they flip any per-session toggle.
function isShared(config, proj, sessionId) {
  if (!sessionId) return false;
  const list = proj && proj.sharedSessions;
  if (Array.isArray(list)) return list.includes(sessionId);
  return (((config && config.team) || {}).sharePrompts === true);
}
```

Then, in `pushProject`, replace the global gate (currently `const share = (((config && config.team) || {}).sharePrompts === true);` at `lib/teamsync.js:568`) and the two per-row uses (`lib/teamsync.js:578-579`):

```js
// (delete the `const share = …` line)
// inside the .map(e => ({ ... })):
ask: isShared(config, proj, e.session) ? scrub(e.ask, 400) : null,
goal: isShared(config, proj, e.session) ? scrub(e.goal, 200) : null,
```

Add `isShared` to the `module.exports` object.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/run-tests.js 2>&1 | grep "teamsync: isShared"`
Expected: PASS. Then confirm the legacy gating tests still pass:

Run: `node test/run-tests.js 2>&1 | grep -E "goal gated by sharePrompts|goal ships \(scrubbed\)|sharePrompts=true uploads"`
Expected: all PASS (legacy fallback preserves them).

- [ ] **Step 5: Commit**

```bash
git add lib/teamsync.js test/run-tests.js
git commit -m "feat: per-session prompt gating via isShared (legacy sharePrompts honored)"
```

---

## Task 2: Extract `entryToRow` + `upsertEntries` (DRY seam for reshare)

**Files:**
- Modify: `lib/teamsync.js` (`pushProject`, `lib/teamsync.js:553-634`)
- Test: existing push tests are the regression guard (no new test needed — this is a pure refactor).

- [ ] **Step 1: Extract the row builder**

Add near `encryptRow` (`lib/teamsync.js:308`):

```js
// Build ONE plaintext memory_entries row from a local entry. `share` decides
// whether the verbatim prompt (ask/goal) rides along — the caller passes the
// isShared() result (push) or an explicit boolean (reshare). Non-prompt fields
// ship regardless. Mirrors the shape the backend upserts on
// (project_id, author_id, ts, source).
function entryToRow(e, projectId, creds, share, regexes) {
  const scrub = (text, n) => (text ? digest.clip(digest.redactText(text, regexes), n) : text);
  return {
    project_id: projectId,
    author_id: creds.userId,
    author_name: creds.displayName,
    ts: e.ts,
    source: e.source,
    session: e.session || null,
    ask: share ? scrub(e.ask, 400) : null,
    goal: share ? scrub(e.goal, 200) : null,
    decisions: e.decisions ? scrub(e.decisions, 240) : null,
    gotchas: e.gotchas ? scrub(e.gotchas, 240) : null,
    files: e.files,
    changes: Array.isArray(e.changes) && e.changes.length ? e.changes.map(c => ({ ...c, note: scrub(c.note, 80) })) : null,
    summary: e.summary ? scrub(e.summary, 300) : null,
  };
}
```

- [ ] **Step 2: Extract the upsert loop**

Add near `entryToRow`:

```js
// POST a batch of memory_entries rows, degrading gracefully when the backend
// predates one of the optional columns (PGRST204): drop that column and retry
// until the insert lands. `prefer` selects insert-vs-overwrite semantics:
//   'resolution=ignore-duplicates,return=minimal'  → normal push (never clobber)
//   'resolution=merge-duplicates,return=minimal'   → reshare (overwrite in place)
async function upsertEntries(config, creds, rows, prefer) {
  let attempt = rows;
  for (;;) {
    try {
      await rest(config, creds, 'POST', 'memory_entries?on_conflict=project_id,author_id,ts,source', attempt, { Prefer: prefer });
      return;
    } catch (err) {
      const m = /'(summary|goal|decisions|gotchas|changes|ciphertext|nonce|key_epoch)' column/i.exec(err.message);
      if (!m) throw err;
      const drop = m[1];
      attempt = attempt.map(({ [drop]: _omit, ...bare }) => bare);
    }
  }
}
```

- [ ] **Step 3: Rewrite `pushProject`'s batch loop to use both**

Replace the body of the `for (let i = 0; i < entries.length; i += PUSH_BATCH)` loop (`lib/teamsync.js:570-631`) with:

```js
for (let i = 0; i < entries.length; i += PUSH_BATCH) {
  const plainRows = entries.slice(i, i + PUSH_BATCH)
    .map(e => entryToRow(e, link.projectId, creds, isShared(config, proj, e.session), regexes));
  let rows = plainRows;
  if (crypto && crypto.teamKey) {
    try {
      rows = plainRows.map(r => encryptRow(r, crypto.teamKey, crypto.epoch, { teamcrypto: crypto.teamcrypto }));
    } catch (err) {
      util.log(`team encrypt: encrypt failed (${err.message}) — pushing plaintext for this batch`);
      rows = plainRows;
    }
  }
  await upsertEntries(config, creds, rows, 'resolution=ignore-duplicates,return=minimal');
  pushed += rows.length;
}
```

Keep the surrounding lines (the `cursor`/`entries`/`regexes`/`scrub` setup at `lib/teamsync.js:554-568` — but `scrub` now lives inside `entryToRow`, so delete the outer `scrub` const if it is now unused; `regexes` is still needed and passed in) and `proj.teamPushTs = entries[entries.length - 1].ts; return pushed;` at the end.

- [ ] **Step 4: Run the suite to verify no regression**

Run: `node test/run-tests.js 2>&1 | tail -5`
Expected: same pass count as before this task (the extraction is behavior-preserving). Pay attention to the push/goal/decisions tests around `test/run-tests.js:3445-3588`.

- [ ] **Step 5: Commit**

```bash
git add lib/teamsync.js
git commit -m "refactor: extract entryToRow + upsertEntries from pushProject"
```

---

## Task 3: Mock backend — honor `merge-duplicates`

**Files:**
- Modify: `test/mock-supabase.js` (`handleEntries`, `lib/`… dispatch at `test/mock-supabase.js:298`)
- Test: `test/run-tests.js` (added in Task 4 exercises it; add a focused assertion here)

- [ ] **Step 1: Write the failing test**

```js
check('mock: merge-duplicates overwrites an existing row in place', async () => {
  const m = createMockSupabase();
  await new Promise(r => m.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + m.server.address().port + '/rest/v1/';
  // Seed auth + membership the same way the team tests do, or reach into the
  // mock's arrays directly:
  const uid = 'u1', pid = 'p1', tid = 't1';
  m.teams.set(tid, { id: tid, name: 'T', inviteCode: 'x' });
  m.projects.push({ id: pid, teamId: tid, name: 'proj', repoUrl: null });
  m.members.push({ teamId: tid, userId: uid, displayName: 'U', role: 'owner' });
  const token = 'at-merge-test'; m.sessions.set(token, uid);
  const row = { project_id: pid, author_id: uid, author_name: 'U', ts: '2026-01-01T00:00:00Z', source: 'Claude Code', session: 's1', ask: null };
  const post = (body, prefer) => fetch(base + 'memory_entries?on_conflict=project_id,author_id,ts,source', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, Prefer: prefer }, body: JSON.stringify([body]),
  });
  await post(row, 'resolution=ignore-duplicates,return=minimal');
  await post({ ...row, ask: 'the shared prompt' }, 'resolution=ignore-duplicates,return=minimal'); // ignored (dup)
  assert.strictEqual(m.entries.filter(e => e.session === 's1')[0].ask, null, 'ignore-duplicates wrongly overwrote');
  await post({ ...row, ask: 'the shared prompt' }, 'resolution=merge-duplicates,return=minimal'); // overwrites
  assert.strictEqual(m.entries.filter(e => e.session === 's1')[0].ask, 'the shared prompt', 'merge-duplicates did not overwrite');
  m.server.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run-tests.js 2>&1 | grep "mock: merge-duplicates"`
Expected: FAIL — the second (merge) POST is treated as a dup and skipped, so `ask` stays `null`.

- [ ] **Step 3: Write minimal implementation**

Thread the `Prefer` header into `handleEntries`. At the dispatch (`test/mock-supabase.js:299`):

```js
if (url.pathname === '/rest/v1/memory_entries') {
  return handleEntries(res, url, req.method, body, authedUser(req), req.headers.prefer || '');
}
```

Update the signature and the dup branch in `handleEntries` (`test/mock-supabase.js:205`, `:225-227`):

```js
function handleEntries(res, url, method, body, userId, prefer) {
  // ...unchanged column-rejection + RLS checks...
  const merge = /merge-duplicates/.test(prefer || '');
  for (const r of rows) {
    // ...unchanged RLS check...
    const idx = entries.findIndex(e => e.project_id === r.project_id && e.author_id === r.author_id && e.ts === r.ts && e.source === r.source);
    if (idx >= 0) {
      if (merge) entries[idx] = { ...entries[idx], ...r }; // resolution=merge-duplicates: overwrite in place
      continue;                                            // resolution=ignore-duplicates: leave as-is
    }
    stats.inserts++;
    entries.push({ ...r, id: entries.length + 1, created_at: new Date(Date.now() + entries.length).toISOString() });
  }
  res.writeHead(201);
  return res.end();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/run-tests.js 2>&1 | grep "mock: merge-duplicates"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/mock-supabase.js test/run-tests.js
git commit -m "test: mock backend honors merge-duplicates upsert"
```

---

## Task 4: `reshareSession` — backfill + scrub (plaintext)

**Files:**
- Modify: `lib/teamsync.js` (new `reshareSession`; export it)
- Test: `test/run-tests.js`

`reshareSession(config, projectPath, sessionId, share, opts)` re-pushes one session's rows with `merge-duplicates`. It accepts `opts.crypto` (an explicit `{ teamKey, epoch, teamcrypto }`, used by tests and the encrypted path) — when absent it resolves the team's key itself via `opts.cryptoDeps` (the same injection seam `syncTeams` uses). It does NOT persist `sharedSessions` — the caller (Task 5) owns that.

- [ ] **Step 1: Write the failing test**

Reuse the linked-project fixture the team tests already build (a project linked to a team on a `createMockSupabase()` instance). After a normal push leaves session `sA` unshared (`ask:null`), reshare it on and off:

```js
check('teamsync: reshareSession backfills then scrubs a session prompt (plaintext)', async () => {
  const { config, creds, projectPath, proj, mock, link } = await setupLinkedProject(); // helper per the existing team tests
  // proj has an entry with session 'sA', ask 'do the thing', unshared by default.
  await teamsync.pushProject(config, creds, projectPath, proj, link, null);
  let row = mock.entries.filter(e => e.session === 'sA')[0];
  assert.strictEqual(row.ask, null, 'precondition: unshared');

  await teamsync.reshareSession(config, projectPath, 'sA', true, { creds, crypto: null });
  row = mock.entries.filter(e => e.session === 'sA')[0];
  assert.ok(row.ask && /do the thing/.test(row.ask), 'backfill did not populate ask');

  await teamsync.reshareSession(config, projectPath, 'sA', false, { creds, crypto: null });
  row = mock.entries.filter(e => e.session === 'sA')[0];
  assert.strictEqual(row.ask, null, 'scrub did not clear ask');
});
```

If the suite has no `setupLinkedProject` helper yet, factor one from the existing team-push test setup (the block that seeds a `createMockSupabase`, signs up/logs in, links a project, and writes a `.membridge` entry) — the goal/decisions push tests around `test/run-tests.js:3397-3469` show every piece.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run-tests.js 2>&1 | grep "teamsync: reshareSession backfills"`
Expected: FAIL — `teamsync.reshareSession is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `lib/teamsync.js`:

```js
// Re-push ONE session's rows with the verbatim prompt forced on (share=true,
// backfill) or off (share=false, scrub). Overwrites already-synced rows via
// merge-duplicates and reuses encryptRow, so encrypted teams stay encrypted.
// Resolves creds/link/team-key itself unless the caller injects them (tests).
async function reshareSession(config, projectPath, sessionId, share, opts = {}) {
  const creds = opts.creds || loadCredentials();
  if (!creds) return { ok: false, error: 'not logged in' };
  const key = path.resolve(projectPath);
  const link = opts.link || loadTeamLink(key);
  if (!link || !link.projectId) return { ok: true, unlinked: true }; // nothing on the backend to reshare

  const state = util.loadState();
  const proj = (state.projects || {})[key] || (state.projects || {})[projectPath];
  if (!proj) return { ok: false, error: 'unknown project' };
  if (!Array.isArray(proj.events)) proj.events = [];

  const rowsSrc = memorydb.buildEntries(projectPath, proj, config).filter(e => (e.session || null) === sessionId);
  if (!rowsSrc.length) return { ok: true, count: 0 };

  const regexes = digest.compileRedactions(config);
  let crypto = opts.crypto;
  if (crypto === undefined) crypto = await resolveOneShotCrypto(config, creds, link, opts);

  for (let i = 0; i < rowsSrc.length; i += PUSH_BATCH) {
    const plainRows = rowsSrc.slice(i, i + PUSH_BATCH).map(e => entryToRow(e, link.projectId, creds, !!share, regexes));
    let rows = plainRows;
    if (crypto && crypto.teamKey) {
      try { rows = plainRows.map(r => encryptRow(r, crypto.teamKey, crypto.epoch, { teamcrypto: crypto.teamcrypto })); }
      catch (err) { util.log(`team encrypt: reshare encrypt failed (${err.message}) — plaintext`); rows = plainRows; }
    }
    await upsertEntries(config, creds, rows, 'resolution=merge-duplicates,return=minimal');
  }
  return { ok: true, count: rowsSrc.length };
}

// One-shot crypto resolution for an out-of-band reshare — mirrors the per-pass
// block in syncTeams, scoped to a single call. Fail-closed to null (plaintext)
// on any error, exactly like the sync path. opts.cryptoDeps injects fakes.
async function resolveOneShotCrypto(config, creds, link, opts = {}) {
  if ((((config || {}).team || {}).encrypt !== true) || !link.teamId) return null;
  try {
    const deps = {
      keychain: require('./keychain'),
      teamcrypto: require('./teamcrypto'),
      uploadPubkey: row => rest(config, creds, 'POST', 'member_pubkeys?on_conflict=user_id', [row], { Prefer: 'resolution=merge-duplicates,return=minimal' }),
      ...(opts.cryptoDeps || {}),
    };
    const identity = await ensureIdentity(creds, deps);
    if (!identity) return null;
    const ctx = { identity, teamcrypto: deps.teamcrypto, cache: new Map(), warned: new Set() };
    const keyDeps = mkTeamKeyDeps(config, creds, link.teamId, ctx);
    const teamKey = await resolveTeamKey(ctx.identity, KEY_EPOCH, keyDeps);
    return teamKey ? { teamKey, epoch: KEY_EPOCH, teamcrypto: deps.teamcrypto } : null;
  } catch (err) {
    util.log(`team encrypt: reshare key resolution failed (${err.message}) — plaintext`);
    return null;
  }
}
```

Export `reshareSession` in `module.exports`. Confirm `loadCredentials`, `loadTeamLink`, `ensureIdentity`, `mkTeamKeyDeps`, `resolveTeamKey`, `KEY_EPOCH`, `PUSH_BATCH`, `digest`, `memorydb`, `util`, `path` are all already in scope in `teamsync.js` (they are — used by `pushProject`/`syncTeams`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/run-tests.js 2>&1 | grep "teamsync: reshareSession backfills"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/teamsync.js test/run-tests.js
git commit -m "feat: reshareSession backfills/scrubs one session's prompt via merge-duplicates"
```

---

## Task 5: Encrypted reshare path

**Files:**
- Test: `test/run-tests.js` (implementation already handles crypto via `opts.crypto`; this task proves it)

- [ ] **Step 1: Write the failing test**

Pass an explicit team key so the assertion decrypts the stored ciphertext — no keychain needed:

```js
check('teamsync: reshareSession encrypts the backfilled prompt', async () => {
  const tc = require('../lib/teamcrypto');
  await tc.ready();
  const teamKey = tc.genTeamKey();
  const { config, creds, projectPath, proj, mock, link } = await setupLinkedProject();
  const cfgEnc = { ...config, team: { ...(config.team || {}), encrypt: true } };

  await teamsync.reshareSession(cfgEnc, projectPath, 'sA', true, { creds, crypto: { teamKey, epoch: 1, teamcrypto: tc } });
  const row = mock.entries.filter(e => e.session === 'sA')[0];
  assert.ok(row.ciphertext && row.nonce, 'row was not encrypted');
  const payload = tc.decrypt(row.ciphertext, row.nonce, teamKey);
  assert.ok(payload && /do the thing/.test(payload.ask), 'encrypted payload missing the shared prompt');

  await teamsync.reshareSession(cfgEnc, projectPath, 'sA', false, { creds, crypto: { teamKey, epoch: 1, teamcrypto: tc } });
  const row2 = mock.entries.filter(e => e.session === 'sA')[0];
  const payload2 = tc.decrypt(row2.ciphertext, row2.nonce, teamKey);
  assert.strictEqual(payload2.ask, null, 'scrub left the prompt in the ciphertext');
});
```

- [ ] **Step 2: Run test to verify it fails, then passes**

Run: `node test/run-tests.js 2>&1 | grep "reshareSession encrypts"`
Expected: this should PASS immediately if Task 4's `opts.crypto` branch is correct. If it FAILS because `libsodium-wrappers` is unavailable in the test env, guard the test: `if (!tc.available()) { results.push([name, null]); return; }` (skip-as-pass), matching how the existing E2E crypto tests around `test/run-tests.js:4462` guard themselves.

- [ ] **Step 3: Commit**

```bash
git add test/run-tests.js
git commit -m "test: reshareSession encrypts backfill and scrubs ciphertext"
```

---

## Task 6: `POST /api/share-session` endpoint

**Files:**
- Modify: `lib/server.js` (route table near `/api/sync`, `lib/server.js:749`)
- Test: `test/run-tests.js`

- [ ] **Step 1: Write the failing test**

```js
check('server: /api/share-session persists the flag and reshares', async () => {
  // Linked project with an unshared session 'sA' already pushed.
  const r = await httpPost(PORT, '/api/share-session', { project: PROJECT_PATH, session: 'sA', share: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.shared, true);
  // Local flag persisted:
  const state = JSON.parse(read(STATE_PATH));
  assert.ok((state.projects[PROJECT_PATH].sharedSessions || []).includes('sA'));
  // Toggling off removes it:
  const r2 = await httpPost(PORT, '/api/share-session', { project: PROJECT_PATH, session: 'sA', share: false });
  assert.strictEqual(r2.shared, false);
  const state2 = JSON.parse(read(STATE_PATH));
  assert.ok(!(state2.projects[PROJECT_PATH].sharedSessions || []).includes('sA'));
});
```

(Use the suite's in-process server + its state-file path constant; the team/settings tests near `test/run-tests.js:820` establish `PORT`, and `STATE_PATH` is `MEMBRIDGE_HOME/state.json` — reuse whatever the existing tests already reference for state.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run-tests.js 2>&1 | grep "server: /api/share-session"`
Expected: FAIL — route returns 404.

- [ ] **Step 3: Write minimal implementation**

Add the route in `lib/server.js` (persist the flag first — intent survives a network failure and the next sync reconciles — then reshare):

```js
} else if (req.method === 'POST' && url.pathname === '/api/share-session') {
  const body = await readBody(req);
  const projectPath = String(body.project || '').trim();
  const session = String(body.session || '').trim();
  const share = !!body.share;
  if (!projectPath || !session) return json(res, 400, { error: 'project and session required' });
  const state = loadState();
  const key = findProjectKey(state, projectPath);
  const proj = key ? state.projects[key] : null;
  if (!proj) return json(res, 404, { error: 'unknown project' });
  // Persist the per-session flag (authoritative for future normal pushes).
  const set = new Set(Array.isArray(proj.sharedSessions) ? proj.sharedSessions : []);
  if (share) set.add(session); else set.delete(session);
  proj.sharedSessions = [...set];
  saveState(state);
  // Retroactively backfill/scrub already-synced rows. Best-effort: report but
  // don't fail the toggle if the backend is unreachable (next sync reconciles).
  let reshare = { ok: true };
  try { reshare = await teamsync.reshareSession(getConfig(), key, session, share); }
  catch (err) { reshare = { ok: false, error: err.message }; }
  json(res, 200, { ok: true, shared: share, reshare });
}
```

Confirm `teamsync` is required at the top of `lib/server.js` (it is — used by `teamPayload`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/run-tests.js 2>&1 | grep "server: /api/share-session"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/server.js test/run-tests.js
git commit -m "feat: POST /api/share-session persists flag + reshares"
```

---

## Task 7: Feed annotates the user's own entries with `shared`

**Files:**
- Modify: `lib/feed.js` (`normalizeLocal`, `lib/feed.js:19`)
- Modify: `lib/server.js` (`feedPayload`, `lib/server.js:104-124`)
- Test: `test/run-tests.js`

- [ ] **Step 1: Write the failing test**

```js
check('feed: local self entries carry a shared flag', () => {
  const meta = { projectName: 'p', projectPath: '/p', authorId: 'u1' };
  const on = feed.normalizeLocal({ ts: '2026-01-01T00:00:00Z', session: 's1', ask: 'hi', shared: true }, meta);
  const off = feed.normalizeLocal({ ts: '2026-01-01T00:00:00Z', session: 's2', ask: 'hi', shared: false }, meta);
  assert.strictEqual(on.shared, true);
  assert.strictEqual(off.shared, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run-tests.js 2>&1 | grep "feed: local self entries carry"`
Expected: FAIL — `on.shared` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `lib/feed.js` `normalizeLocal`, add to the returned object (near `self: true`):

```js
shared: !!e.shared,
```

In `lib/feed.js` `normalizeTeam`, add `shared: false` (teammates' rows are never self-toggleable) so the field exists uniformly.

In `lib/server.js` `feedPayload`, annotate each local entry before normalizing (`lib/server.js:124`):

```js
for (const e of memorydb.buildEntries(key, proj, config)) {
  local.push(feed.normalizeLocal({ ...e, shared: teamsync.isShared(config, proj, e.session) }, meta));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/run-tests.js 2>&1 | grep "feed: local self entries carry"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/feed.js lib/server.js test/run-tests.js
git commit -m "feat: feed carries per-session shared flag on self entries"
```

---

## Task 8: Session card toggle (self cards only)

**Files:**
- Modify: `lib/dashboard.js` (`threadHtml` `lib/dashboard.js:2472`, `unitHtml` `lib/dashboard.js:2556`, and a delegated click handler)
- Test: manual (client JS isn't unit-tested); Task 6/7 cover the data + endpoint.

- [ ] **Step 1: Add a toggle-HTML helper**

Add near `cardCloseHtml` (`lib/dashboard.js:2437`):

```js
// The team-visibility toggle for one of YOUR OWN sessions. You always see your
// own prompt locally; this controls whether teammates do. Rendered only when
// the newest entry is self + has a session id + a local project path (needed to
// POST). Returns '' for teammates' cards.
function shareToggleHtml(newest) {
  if (!newest || !newest.self || !newest.session || !newest.projectPath) return '';
  var on = !!newest.shared;
  var label = on ? 'Visible to team' : 'Hidden from team';
  var color = on ? 'var(--green)' : 'var(--text3)';
  var dot = on ? '&#128275;' : '&#128274;'; // 🔓 / 🔒
  return '<span data-share-toggle style="cursor:pointer;flex:none;display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:99px;border:1px solid var(--border);font-size:10.5px;font-weight:600;color:' + color + '" ' +
    'data-share-session="' + esc(newest.session) + '" data-share-project="' + esc(newest.projectPath) + '" data-share-on="' + (on ? '1' : '0') + '" title="Toggle whether teammates see this session&rsquo;s prompts">' +
    dot + '&nbsp;' + label + '</span>';
}
```

- [ ] **Step 2: Render it in both card headers**

In `threadHtml`, insert `shareToggleHtml(newest)` into the meta row — put it just before the `data-ago` span (`lib/dashboard.js:2502`), so it sits inline with the tool pill / project / time:

```js
// ...existing project pill span...
shareToggleHtml(newest) +
'<span style="margin-left:auto;flex:none" data-ago="' + esc(t.ts) + '">' + esc(ago(t.ts)) + '</span>' +
```

Do the same in `unitHtml`'s meta row (`lib/dashboard.js:2556`+, wherever its `data-ago`/count row is assembled — mirror the `threadHtml` placement using that function's `newest`/`u` representative entry).

- [ ] **Step 3: Delegated click handler**

Find the document-level click listener that already handles `[data-card-close]` / `[data-card-toggle]` (search `lib/dashboard.js` for `data-card-close`). Add, BEFORE the card-toggle branch so a toggle click doesn't also expand the card, and stop propagation:

```js
var shareEl = e.target.closest('[data-share-toggle]');
if (shareEl) {
  e.stopPropagation();
  if (shareEl.getAttribute('data-busy') === '1') return;
  shareEl.setAttribute('data-busy', '1');
  var makeShared = shareEl.getAttribute('data-share-on') !== '1';
  fetch('/api/share-session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: shareEl.getAttribute('data-share-project'), session: shareEl.getAttribute('data-share-session'), share: makeShared }),
  }).then(function (r) { return r.json(); })
    .then(function () { loadHome(); })          // re-fetch the feed so the toggle + prompt visibility refresh
    .catch(function () { setPill(false); shareEl.removeAttribute('data-busy'); });
  return;
}
```

If the feed is rendered by a function other than `loadHome` in the current view (e.g. the project detail screen), call that view's loader instead — match the refresh call the sibling handlers in the same listener use.

- [ ] **Step 4: Verify manually**

Rebuild/reinstall per repo norm. On your own "(prompt not shared)" card, confirm a "Hidden from team" pill shows; click it → it flips to "Visible to team", and a teammate (or a second account) now sees the prompt. Toggle off → teammate sees "(prompt not shared)" again. Confirm teammates' cards show no pill.

Guard against server regressions:
Run: `node test/run-tests.js 2>&1 | tail -3`
Expected: suite green.

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard.js
git commit -m "feat: per-session Visible-to-team toggle on your own cards"
```

---

## Self-Review

**Spec coverage (Feature 2 of the design doc):**
- `sharedSessions` per-project + `isShared` single source of truth → Task 1. ✔
- Per-entry gating in `pushProject` → Tasks 1–2. ✔
- Retroactive symmetric backfill + scrub via `merge-duplicates`, encryption-safe → Tasks 3–5. ✔
- Legacy `sharePrompts` honor-window → Task 1 (asserted; existing tests stay green). ✔
- `POST /api/share-session` persists flag then reshares, error-tolerant → Task 6. ✔
- Toggle on `self` cards only, controls team visibility → Tasks 7–8. ✔
- Scope = verbatim prompt (`ask`/`goal`) only; other fields ship regardless → `entryToRow` (Task 2). ✔

**Placeholder scan:** the only external references are the suite's own fixtures (`setupLinkedProject`, `PORT`, `STATE_PATH`, `httpPost`, `read`) — each is either already present in `test/run-tests.js` or explicitly instructed to be factored from the existing team-test setup, with the source lines named. No TBD/TODO; every implementation step shows complete code.

**Type consistency:** `isShared(config, proj, sessionId)` signature is identical across `pushProject`, `feedPayload`, and tests. `entryToRow(e, projectId, creds, share, regexes)` and `upsertEntries(config, creds, rows, prefer)` signatures match every call site (push + reshare). `reshareSession(config, projectPath, sessionId, share, opts)` with `opts.{creds,link,crypto,cryptoDeps}` is consistent between Tasks 4/5/6. The feed `shared` boolean is produced in `feedPayload` (server) and consumed by `shareToggleHtml` via `newest.shared`.

**Ordering / dependencies:** Task 3 (mock merge-duplicates) must land before Task 4's reshare test can pass. Task 2's refactor must land before Task 4 reuses `entryToRow`/`upsertEntries`. Task 7 (feed `shared`) must land before Task 8's toggle reflects real state. Recommended execution order = Task number order.
