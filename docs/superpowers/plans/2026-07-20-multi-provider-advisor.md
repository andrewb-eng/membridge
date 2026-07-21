# Multi-Provider Advisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user run the BYOK advisor (catch-up briefing + roadmap planner) on Anthropic, OpenAI, Google Gemini, or a local / OpenAI-compatible endpoint, picking a model per provider — instead of the current Anthropic-only hard-wiring.

**Architecture:** Introduce a provider-adapter registry under `lib/advisors/`. Each adapter is a small module implementing one interface (`generate`, `testKey`, `models`, `priceFor`, metadata). `lib/advisor.js` keeps its public functions (`generatePlan`, `generateBriefing`, `testKey`, `estimateCost`, `getAdvisorConfig`) but delegates the vendor call to the selected adapter and owns the shared orchestration (prompt building, JSON parsing with a tolerant fallback, cost math). Config gains `advisor.provider` + `advisor.providers.{id}` with lazy, non-destructive migration of the legacy `advisor.apiKey`/`advisor.model`.

**Tech Stack:** Node.js, zero runtime deps (raw `fetch`, same as today). Offline test suite in `test/run-tests.js` with `MEMBRIDGE_API_BASE` pointed at in-process mock servers.

**Companion spec:** [../specs/2026-07-20-multi-provider-advisor-and-per-session-sharing-design.md](../specs/2026-07-20-multi-provider-advisor-and-per-session-sharing-design.md) (Feature 1).

---

## File Structure

- **Create** `lib/advisors/index.js` — registry (`byId`, `list`) + shared helpers (`normError`, `extractJson`).
- **Create** `lib/advisors/anthropic.js` — Anthropic adapter (ports today's request/response code).
- **Create** `lib/advisors/openai.js` — OpenAI Chat Completions adapter.
- **Create** `lib/advisors/google.js` — Gemini `generateContent` adapter.
- **Create** `lib/advisors/openai-compatible.js` — generic OpenAI-shaped adapter for local endpoints (base-URL required, tolerant JSON).
- **Modify** `lib/advisor.js` — delegate to adapters; multi-provider `getAdvisorConfig` + migration; keep public API back-compatible.
- **Modify** `lib/server.js` — `settingsPayload`/`saveSettings` multi-provider; new `/api/advisor` GET/POST + provider-aware `/api/settings/test`; route `generatePlan`/`generateBriefing` to the selected provider.
- **Modify** `lib/dashboard.js` — Settings "AI briefings & roadmaps" section: provider selector, model dropdown, key (+ base-URL for local), Test button.
- **Modify** `test/run-tests.js` — new adapter/mocks/migration tests.

### Adapter interface (the contract every adapter file exports)

```js
module.exports = {
  id: 'openai',                 // stable id used in config.advisor.provider
  label: 'OpenAI (GPT)',        // shown in Settings
  needsBaseUrl: false,          // true only for 'local'
  supportsSchema: true,         // false ⇒ advisor.js appends the schema to the prompt
  keyEnv: ['OPENAI_API_KEY'],   // env fallbacks, in priority order
  models: [                     // curated catalog; priceIn/priceOut = USD per 1M tokens (null for local)
    { id: 'gpt-4o-mini', label: 'Fast & cheap', priceIn: 0.15, priceOut: 0.60 },
    // ...
  ],
  priceFor(model) { /* → [priceIn, priceOut] in USD/1M, or [0,0] if unknown */ },
  async testKey({ apiKey, baseUrl }) { /* → { ok:true } | { ok:false, error } */ },
  async generate({ apiKey, baseUrl, model, system, prompt, schema, maxTokens, signal }) {
    // schema present ⇒ ask for structured JSON; schema null ⇒ free-form text.
    // → { text, usage:{ input_tokens, output_tokens, cache_creation_input_tokens?, cache_read_input_tokens? } }
    //   | { error, status }   (never throws for expected failures)
  },
};
```

`usage` is always normalized to `{ input_tokens, output_tokens, ... }` so `advisor.actualCost` stays provider-agnostic.

---

## Task 1: Registry + shared helpers

**Files:**
- Create: `lib/advisors/index.js`
- Test: `test/run-tests.js`

- [ ] **Step 1: Write the failing test**

Add near the other advisor tests (after the block around `test/run-tests.js:1673`):

```js
// --- Multi-provider advisor: registry + shared helpers ---
const advisors = require('../lib/advisors');
check('advisors: registry lists providers and looks them up by id', () => {
  const ids = advisors.list().map(a => a.id);
  assert.deepStrictEqual(ids, ['anthropic', 'openai', 'google', 'local']);
  assert.strictEqual(advisors.byId('openai').label, 'OpenAI (GPT)');
  assert.strictEqual(advisors.byId('nope'), null);
});
check('advisors: extractJson recovers an object from surrounding prose', () => {
  assert.deepStrictEqual(advisors.extractJson('sure!\n{"a":1,"b":[2,3]}\ndone'), { a: 1, b: [2, 3] });
  assert.strictEqual(advisors.extractJson('no json here'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run-tests.js 2>&1 | grep -E "advisors: (registry|extractJson)"`
Expected: FAIL — `Cannot find module '../lib/advisors'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/advisors/index.js` (adapters are required lazily so Task 1 passes before Tasks 2–5 exist — fill the array as each adapter lands):

```js
'use strict';
// Provider-adapter registry for the BYOK advisor. Each adapter implements the
// interface documented in the plan; advisor.js selects one by id and owns the
// shared orchestration (prompt building, JSON parsing, cost math).

function load(id, mod) {
  try { return require(mod); } catch { return null; }
}

// Order defines the Settings dropdown order. Anthropic first (the default).
const ADAPTERS = [
  load('anthropic', './anthropic'),
  load('openai', './openai'),
  load('google', './google'),
  load('local', './openai-compatible'),
].filter(Boolean);

function list() { return ADAPTERS.slice(); }
function byId(id) { return ADAPTERS.find(a => a.id === id) || null; }

// Tolerant JSON recovery for models that wrap their answer in prose or fences.
// Returns the first balanced top-level object, or null.
function extractJson(text) {
  const s = String(text == null ? '' : text);
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

module.exports = { list, byId, extractJson };
```

Because Tasks 2–5 create the adapter files, `list()` starts as `[]` until Task 2 lands the Anthropic adapter. To make Task 1's ordering assertion meaningful now, implement Task 2 before running the ordering assertion, OR temporarily assert `Array.isArray(advisors.list())`. Keep the `extractJson` assertions active now; update the ordering assertion's expected array as adapters land (it reaches the full four after Task 5).

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/run-tests.js 2>&1 | grep -E "advisors: extractJson"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/advisors/index.js test/run-tests.js
git commit -m "feat: advisor provider registry + tolerant JSON helper"
```

---

## Task 2: Anthropic adapter (port existing behavior)

**Files:**
- Create: `lib/advisors/anthropic.js`
- Test: `test/run-tests.js`

- [ ] **Step 1: Write the failing test**

The existing advisor tests already exercise Anthropic end-to-end via `MEMBRIDGE_API_BASE`. Add a direct adapter test alongside them:

```js
check('advisors/anthropic: generate returns text + normalized usage', async () => {
  process.env.MEMBRIDGE_API_BASE = 'http://127.0.0.1:17944'; // existing Anthropic mock
  const a = advisors.byId('anthropic');
  const r = await a.generate({ apiKey: GOOD_KEY, model: 'claude-sonnet-5', system: 'sys', prompt: 'hi', schema: null, maxTokens: 200 });
  assert.ok(r.text && typeof r.text === 'string', 'no text');
  assert.ok(Number.isFinite(r.usage.input_tokens), 'usage not normalized');
  assert.strictEqual(a.priceFor('claude-haiku-4-5')[0], 1);
});
```

(This test is async — see "Async tests" note at the end of this plan.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run-tests.js 2>&1 | grep "advisors/anthropic"`
Expected: FAIL — `byId('anthropic')` is null (adapter file missing).

- [ ] **Step 3: Write minimal implementation**

Create `lib/advisors/anthropic.js` by moving the Anthropic-specific request/response logic out of today's `advisor.js` (the `postMessages`/`generatePlan`/`generateBriefing`/`testKey` internals). Keep the exact endpoints, retry, timeout, and error strings:

```js
'use strict';
const API_VERSION = '2023-06-01';
function apiBase() { return process.env.MEMBRIDGE_API_BASE || 'https://api.anthropic.com'; }

const MODELS = [
  { id: 'claude-haiku-4-5', label: 'Fast & cheap (~1¢ per roadmap)', priceIn: 1, priceOut: 5 },
  { id: 'claude-sonnet-5', label: 'Smarter (~4¢)', priceIn: 2, priceOut: 10 },
  { id: 'claude-opus-4-8', label: 'Deepest (~6¢)', priceIn: 5, priceOut: 25 },
];
function priceFor(model) {
  const m = MODELS.find(x => x.id === model) || MODELS[0];
  return [m.priceIn, m.priceOut];
}

function post(apiKey, body, signal) {
  return fetch(`${apiBase()}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal,
  });
}

async function testKey({ apiKey }) {
  if (!apiKey) return { ok: false, error: 'No key to test — paste one in first.' };
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${apiBase()}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODELS[0].id, messages: [{ role: 'user', content: 'hi' }] }), signal: ctrl.signal,
    });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, error: 'That key was rejected — check it and try again.' };
    let msg = `The Anthropic API answered with an error (${res.status}).`;
    try { const b = await res.json(); if (b && b.error && b.error.message) msg = b.error.message; } catch {}
    return { ok: false, error: msg };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Timed out reaching the Anthropic API — try again.' : 'Could not reach the Anthropic API — are you online?' };
  } finally { clearTimeout(timer); }
}

async function generate({ apiKey, model, system, prompt, schema, maxTokens }) {
  const body = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] };
  if (schema) body.output_config = { format: { type: 'json_schema', schema } };
  if (model === 'claude-sonnet-5') body.thinking = { type: 'disabled' };
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    let res = await post(apiKey, body, ctrl.signal);
    if (res.status === 429 || res.status >= 500) res = await post(apiKey, body, ctrl.signal);
    if (res.status === 401) return { error: 'That key looks invalid — check Settings.', status: 401 };
    if (!res.ok) {
      let msg = `The Anthropic API answered with an error (${res.status}) — try again in a minute.`;
      try { const b = await res.json(); if (b && b.error && b.error.message) msg = b.error.message; } catch {}
      return { error: msg, status: 502 };
    }
    const data = await res.json();
    if (data.stop_reason === 'max_tokens') return { error: 'The plan ran too long and was cut off — try a narrower goal.', status: 502 };
    const text = ((data.content || []).find(b => b.type === 'text') || {}).text || '';
    const u = data.usage || {};
    return { text, usage: { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cache_creation_input_tokens: u.cache_creation_input_tokens || 0, cache_read_input_tokens: u.cache_read_input_tokens || 0 } };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'Timed out waiting for the Anthropic API — try again.' : 'Could not reach the Anthropic API — are you online?', status: 504 };
  } finally { clearTimeout(timer); }
}

module.exports = { id: 'anthropic', label: 'Anthropic (Claude)', needsBaseUrl: false, supportsSchema: true, keyEnv: ['ANTHROPIC_API_KEY'], models: MODELS, priceFor, testKey, generate };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/run-tests.js 2>&1 | grep "advisors/anthropic"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/advisors/anthropic.js test/run-tests.js
git commit -m "feat: Anthropic advisor adapter (ports existing request logic)"
```

---

## Task 3: OpenAI adapter

**Files:**
- Create: `lib/advisors/openai.js`
- Test: `test/run-tests.js` (+ a tiny in-process OpenAI mock)

- [ ] **Step 1: Write the failing test**

Add a minimal OpenAI-shaped mock and a test. Put the mock near the top-level helpers so other tasks can reuse it:

```js
// Minimal OpenAI/Gemini-shaped mock. Returns a fixed JSON plan for schema calls
// and echoes prose otherwise; records the last request body for shape assertions.
function startJsonMock(port, handler) {
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = {}; try { body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}; } catch {}
      handler(req, body, (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); });
    });
  });
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r(srv)));
}

check('advisors/openai: chat-completions request shape + normalized usage', async () => {
  let seen = null;
  const srv = await startJsonMock(17960, (req, body, send) => {
    seen = { url: req.url, body };
    if (req.method === 'GET' && /\/models$/.test(req.url)) return send(200, { data: [{ id: 'gpt-4o' }] });
    send(200, { choices: [{ message: { content: '{"summary":"ok","phases":[],"risks":[],"questions":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });
  try {
    const a = advisors.byId('openai');
    const r = await a.generate({ apiKey: 'sk-x', baseUrl: 'http://127.0.0.1:17960/v1', model: 'gpt-4o', system: 's', prompt: 'p', schema: { type: 'object' }, maxTokens: 300 });
    assert.strictEqual(seen.body.response_format.type, 'json_schema');
    assert.strictEqual(seen.body.messages[0].role, 'system');
    assert.strictEqual(r.usage.input_tokens, 10);
    assert.strictEqual(r.usage.output_tokens, 5);
    const test = await a.testKey({ apiKey: 'sk-x', baseUrl: 'http://127.0.0.1:17960/v1' });
    assert.strictEqual(test.ok, true);
  } finally { srv.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run-tests.js 2>&1 | grep "advisors/openai"`
Expected: FAIL — `byId('openai')` is null.

- [ ] **Step 3: Write minimal implementation**

Create `lib/advisors/openai.js`:

```js
'use strict';
const DEFAULT_BASE = 'https://api.openai.com/v1';
const MODELS = [
  { id: 'gpt-4o-mini', label: 'Fast & cheap', priceIn: 0.15, priceOut: 0.60 },
  { id: 'gpt-4o', label: 'Smarter', priceIn: 2.5, priceOut: 10 },
  { id: 'gpt-4.1', label: 'Deepest', priceIn: 2, priceOut: 8 },
];
function priceFor(model) { const m = MODELS.find(x => x.id === model) || MODELS[0]; return [m.priceIn, m.priceOut]; }
const base = b => (b && b.trim()) || DEFAULT_BASE;

async function testKey({ apiKey, baseUrl }) {
  if (!apiKey) return { ok: false, error: 'No key to test — paste one in first.' };
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${base(baseUrl)}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: ctrl.signal });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, error: 'That key was rejected — check it and try again.' };
    return { ok: false, error: `OpenAI answered with an error (${res.status}).` };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Timed out reaching OpenAI — try again.' : 'Could not reach OpenAI — are you online?' };
  } finally { clearTimeout(timer); }
}

function postBody(model, system, prompt, schema, maxTokens) {
  const body = { model, max_completion_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] };
  if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'membridge_output', schema, strict: false } };
  return body;
}

async function generate({ apiKey, baseUrl, model, system, prompt, schema, maxTokens }) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 60000);
  const send = () => fetch(`${base(baseUrl)}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(postBody(model, system, prompt, schema, maxTokens)), signal: ctrl.signal,
  });
  try {
    let res = await send();
    if (res.status === 429 || res.status >= 500) res = await send();
    if (res.status === 401) return { error: 'That key looks invalid — check Settings.', status: 401 };
    if (!res.ok) {
      let msg = `OpenAI answered with an error (${res.status}) — try again in a minute.`;
      try { const b = await res.json(); if (b && b.error && b.error.message) msg = b.error.message; } catch {}
      return { error: msg, status: 502 };
    }
    const data = await res.json();
    const text = (((data.choices || [])[0] || {}).message || {}).content || '';
    const u = data.usage || {};
    return { text, usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 } };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'Timed out waiting for OpenAI — try again.' : 'Could not reach OpenAI — are you online?', status: 504 };
  } finally { clearTimeout(timer); }
}

module.exports = { id: 'openai', label: 'OpenAI (GPT)', needsBaseUrl: false, supportsSchema: true, keyEnv: ['OPENAI_API_KEY'], models: MODELS, priceFor, testKey, generate };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/run-tests.js 2>&1 | grep "advisors/openai"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/advisors/openai.js test/run-tests.js
git commit -m "feat: OpenAI advisor adapter"
```

---

## Task 4: Google Gemini adapter

**Files:**
- Create: `lib/advisors/google.js`
- Test: `test/run-tests.js`

- [ ] **Step 1: Write the failing test**

```js
check('advisors/google: generateContent shape + schema sanitized + usage', async () => {
  let seen = null;
  const srv = await startJsonMock(17961, (req, body, send) => {
    seen = { url: req.url, body };
    if (req.method === 'GET' && /\/models/.test(req.url)) return send(200, { models: [] });
    send(200, { candidates: [{ content: { parts: [{ text: '{"summary":"ok","phases":[],"risks":[],"questions":[]}' } }] }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 } });
  });
  try {
    const a = advisors.byId('google');
    const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false };
    const r = await a.generate({ apiKey: 'g-x', baseUrl: 'http://127.0.0.1:17961', model: 'gemini-2.0-flash', system: 's', prompt: 'p', schema, maxTokens: 300 });
    // additionalProperties must be stripped for Gemini's schema subset.
    assert.ok(!JSON.stringify(seen.body.generationConfig.responseSchema).includes('additionalProperties'));
    assert.strictEqual(seen.body.generationConfig.responseMimeType, 'application/json');
    assert.strictEqual(r.usage.input_tokens, 12);
    assert.strictEqual(r.usage.output_tokens, 7);
  } finally { srv.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run-tests.js 2>&1 | grep "advisors/google"`
Expected: FAIL — `byId('google')` is null.

- [ ] **Step 3: Write minimal implementation**

Create `lib/advisors/google.js`. Note the key rides as a `?key=` query param on Gemini and the schema must be sanitized (drop `additionalProperties`, which Gemini rejects):

```js
'use strict';
const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODELS = [
  { id: 'gemini-2.0-flash', label: 'Fast & cheap', priceIn: 0.10, priceOut: 0.40 },
  { id: 'gemini-2.5-flash', label: 'Smarter', priceIn: 0.30, priceOut: 2.50 },
  { id: 'gemini-2.5-pro', label: 'Deepest', priceIn: 1.25, priceOut: 10 },
];
function priceFor(model) { const m = MODELS.find(x => x.id === model) || MODELS[0]; return [m.priceIn, m.priceOut]; }
const base = b => (b && b.trim()) || DEFAULT_BASE;

// Gemini accepts an OpenAPI-subset schema: strip keys it rejects (notably
// additionalProperties), recursing through properties/items.
function toGeminiSchema(s) {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'additionalProperties') continue;
    out[k] = toGeminiSchema(v);
  }
  return out;
}

async function testKey({ apiKey, baseUrl }) {
  if (!apiKey) return { ok: false, error: 'No key to test — paste one in first.' };
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${base(baseUrl)}/models?key=${encodeURIComponent(apiKey)}`, { signal: ctrl.signal });
    if (res.ok) return { ok: true };
    if (res.status === 400 || res.status === 401 || res.status === 403) return { ok: false, error: 'That key was rejected — check it and try again.' };
    return { ok: false, error: `Gemini answered with an error (${res.status}).` };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Timed out reaching Gemini — try again.' : 'Could not reach Gemini — are you online?' };
  } finally { clearTimeout(timer); }
}

async function generate({ apiKey, baseUrl, model, system, prompt, schema, maxTokens }) {
  const genConfig = { maxOutputTokens: maxTokens };
  if (schema) { genConfig.responseMimeType = 'application/json'; genConfig.responseSchema = toGeminiSchema(schema); }
  const body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: genConfig };
  const url = `${base(baseUrl)}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 60000);
  const send = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
  try {
    let res = await send();
    if (res.status === 429 || res.status >= 500) res = await send();
    if (res.status === 400 || res.status === 401 || res.status === 403) return { error: 'That key looks invalid — check Settings.', status: 401 };
    if (!res.ok) {
      let msg = `Gemini answered with an error (${res.status}) — try again in a minute.`;
      try { const b = await res.json(); if (b && b.error && b.error.message) msg = b.error.message; } catch {}
      return { error: msg, status: 502 };
    }
    const data = await res.json();
    const parts = ((((data.candidates || [])[0] || {}).content || {}).parts) || [];
    const text = parts.map(p => p.text || '').join('');
    const u = data.usageMetadata || {};
    return { text, usage: { input_tokens: u.promptTokenCount || 0, output_tokens: u.candidatesTokenCount || 0 } };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'Timed out waiting for Gemini — try again.' : 'Could not reach Gemini — are you online?', status: 504 };
  } finally { clearTimeout(timer); }
}

module.exports = { id: 'google', label: 'Google (Gemini)', needsBaseUrl: false, supportsSchema: true, keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], models: MODELS, priceFor, testKey, generate };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/run-tests.js 2>&1 | grep "advisors/google"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/advisors/google.js test/run-tests.js
git commit -m "feat: Google Gemini advisor adapter"
```

---

## Task 5: Local / OpenAI-compatible adapter

**Files:**
- Create: `lib/advisors/openai-compatible.js`
- Test: `test/run-tests.js`

- [ ] **Step 1: Write the failing test**

The local adapter must (a) require a base URL, (b) report `supportsSchema:false` so advisor.js prompts for JSON instead of relying on `response_format`, and (c) still return raw text (advisor.js's `extractJson` recovers the object). Prices are null.

```js
check('advisors/local: needs base URL, no schema support, prices unknown', async () => {
  const a = advisors.byId('local');
  assert.strictEqual(a.needsBaseUrl, true);
  assert.strictEqual(a.supportsSchema, false);
  assert.deepStrictEqual(a.priceFor('anything'), [0, 0]);
  const noBase = await a.generate({ apiKey: '', baseUrl: '', model: 'llama3.1', system: 's', prompt: 'p', schema: null, maxTokens: 100 });
  assert.ok(noBase.error && /base URL/i.test(noBase.error), 'should demand a base URL');

  const srv = await startJsonMock(17962, (req, body, send) => {
    send(200, { choices: [{ message: { content: 'here you go {"summary":"ok","phases":[],"risks":[],"questions":[]}' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
  });
  try {
    const r = await a.generate({ apiKey: '', baseUrl: 'http://127.0.0.1:17962/v1', model: 'llama3.1', system: 's', prompt: 'p', schema: null, maxTokens: 100 });
    assert.ok(r.text.includes('summary'), 'returns raw text');
    assert.strictEqual(r.usage.input_tokens, 3);
  } finally { srv.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run-tests.js 2>&1 | grep "advisors/local"`
Expected: FAIL — `byId('local')` is null.

- [ ] **Step 3: Write minimal implementation**

Create `lib/advisors/openai-compatible.js` (reuses the OpenAI wire shape; base URL mandatory; key optional; no curated catalog):

```js
'use strict';
// Generic OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter, vLLM…).
// Base URL is required; key is optional. No curated model catalog (the user
// types the model id) and no pricing. supportsSchema:false — advisor.js embeds
// the schema in the prompt and recovers JSON with extractJson.
const MODELS = []; // user-supplied model id; nothing to enumerate
function priceFor() { return [0, 0]; }
const trim = b => String(b || '').replace(/\/+$/, '');

async function testKey({ apiKey, baseUrl }) {
  if (!baseUrl || !baseUrl.trim()) return { ok: false, error: 'Enter the endpoint base URL first (e.g. http://localhost:11434/v1).' };
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const res = await fetch(`${trim(baseUrl)}/models`, { headers, signal: ctrl.signal });
    if (res.ok) return { ok: true };
    return { ok: false, error: `The endpoint answered with an error (${res.status}).` };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Timed out reaching the endpoint — is it running?' : 'Could not reach the endpoint — check the base URL.' };
  } finally { clearTimeout(timer); }
}

async function generate({ apiKey, baseUrl, model, system, prompt, maxTokens }) {
  if (!baseUrl || !baseUrl.trim()) return { error: 'Enter the endpoint base URL first (e.g. http://localhost:11434/v1).', status: 400 };
  const body = { model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] };
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const res = await fetch(`${trim(baseUrl)}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
    if (!res.ok) {
      let msg = `The endpoint answered with an error (${res.status}).`;
      try { const b = await res.json(); if (b && b.error && (b.error.message || typeof b.error === 'string')) msg = b.error.message || b.error; } catch {}
      return { error: msg, status: 502 };
    }
    const data = await res.json();
    const text = (((data.choices || [])[0] || {}).message || {}).content || '';
    const u = data.usage || {};
    return { text, usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 } };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'Timed out waiting for the endpoint — try a smaller model or goal.' : 'Could not reach the endpoint — check the base URL.', status: 504 };
  } finally { clearTimeout(timer); }
}

module.exports = { id: 'local', label: 'Local / OpenAI-compatible', needsBaseUrl: true, supportsSchema: false, keyEnv: [], models: MODELS, priceFor, testKey, generate };
```

Now update Task 1's ordering assertion — it should now see all four ids `['anthropic','openai','google','local']`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/run-tests.js 2>&1 | grep -E "advisors: registry|advisors/local"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/advisors/openai-compatible.js test/run-tests.js
git commit -m "feat: local / OpenAI-compatible advisor adapter"
```

---

## Task 6: Rewire advisor.js to delegate + multi-provider config

**Files:**
- Modify: `lib/advisor.js`
- Test: `test/run-tests.js`

- [ ] **Step 1: Write the failing test**

```js
check('advisor: getAdvisorConfig migrates legacy anthropic key + reads providers', () => {
  // Legacy shape (pre-migration): flat apiKey/model, no providers block.
  let cfg = { advisor: { apiKey: 'sk-legacy', model: 'claude-opus-4-8' } };
  let a = advisorLib.getAdvisorConfig(cfg);
  assert.strictEqual(a.provider, 'anthropic');
  assert.strictEqual(a.apiKey, 'sk-legacy');
  assert.strictEqual(a.model, 'claude-opus-4-8');
  assert.strictEqual(a.baseUrl, '');
  // New shape: pick openai + its own model/key.
  cfg = { advisor: { provider: 'openai', providers: { openai: { apiKey: 'sk-oai', model: 'gpt-4o' } } } };
  a = advisorLib.getAdvisorConfig(cfg);
  assert.strictEqual(a.provider, 'openai');
  assert.strictEqual(a.apiKey, 'sk-oai');
  assert.strictEqual(a.model, 'gpt-4o');
  // Local carries a base URL.
  cfg = { advisor: { provider: 'local', providers: { local: { baseUrl: 'http://h/v1', model: 'llama3.1' } } } };
  a = advisorLib.getAdvisorConfig(cfg);
  assert.strictEqual(a.provider, 'local');
  assert.strictEqual(a.baseUrl, 'http://h/v1');
  assert.strictEqual(a.model, 'llama3.1');
});
check('advisor: generatePlan routes to the selected provider', async () => {
  const srv = await startJsonMock(17963, (req, body, send) => {
    if (req.method === 'GET') return send(200, { data: [] });
    send(200, { choices: [{ message: { content: '{"summary":"S","phases":[],"risks":[],"questions":[]}' } }], usage: { prompt_tokens: 8, completion_tokens: 9 } });
  });
  try {
    const r = await advisorLib.generatePlan('sk-oai', 'gpt-4o', { projectName: 'p', goal: 'g', recentAsks: [] }, { provider: 'openai', baseUrl: 'http://127.0.0.1:17963/v1' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.plan.summary, 'S');
    assert.ok(r.costUsd >= 0);
  } finally { srv.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run-tests.js 2>&1 | grep -E "advisor: getAdvisorConfig migrates|advisor: generatePlan routes"`
Expected: FAIL — `getAdvisorConfig` returns the old shape (no `provider`/`baseUrl`); `generatePlan` ignores `opts`.

- [ ] **Step 3: Write minimal implementation**

Rewrite `lib/advisor.js` so it delegates to the registry. Keep `PLAN_SYSTEM`, `PLAN_SCHEMA`, `PLAN_MAX_TOKENS`, `EXPECTED_OUTPUT_TOKENS`, `BRIEFING_SYSTEM`, `BRIEFING_MAX_TOKENS`, `buildPlanPrompt`, `buildBriefingPrompt` exactly as they are. Replace the Anthropic-specific plumbing and the three public functions:

```js
'use strict';
const advisors = require('./advisors');
// ... keep API_VERSION removed (adapters own it), keep PLAN_* / BRIEFING_* / buildPlanPrompt / buildBriefingPrompt ...

const DEFAULT_PROVIDER = 'anthropic';

// Effective advisor settings for the SELECTED provider. Lazy, read-time
// migration of the legacy flat { apiKey, model } (Anthropic-only) into the
// providers map — the file is not rewritten until the next settings save.
function getAdvisorConfig(config) {
  const adv = (config && config.advisor) || {};
  const providers = adv.providers && typeof adv.providers === 'object' ? adv.providers : {};
  const provider = advisors.byId(adv.provider) ? adv.provider : DEFAULT_PROVIDER;
  const adapter = advisors.byId(provider);
  const pconf = providers[provider] || {};

  // Legacy fallback only applies to Anthropic (the only provider that existed).
  const legacyKey = provider === 'anthropic' && !providers.anthropic ? (adv.apiKey || '') : '';
  const legacyModel = provider === 'anthropic' && !providers.anthropic ? adv.model : undefined;
  const envKey = (adapter.keyEnv || []).map(k => process.env[k]).find(Boolean) || '';

  const apiKey = pconf.apiKey || legacyKey || envKey;
  const baseUrl = adapter.needsBaseUrl ? (pconf.baseUrl || '') : '';
  const validModel = m => (adapter.models.length ? adapter.models.some(x => x.id === m) : !!m);
  const model = validModel(pconf.model) ? pconf.model
    : validModel(legacyModel) ? legacyModel
    : (adapter.models[0] ? adapter.models[0].id : (pconf.model || ''));

  return {
    provider, adapter, apiKey, baseUrl, model,
    source: pconf.apiKey ? 'config' : (legacyKey ? 'config' : (envKey ? 'env' : null)),
  };
}

function actualCost(adapter, usage) {
  const [pin, pout] = adapter.priceFor ? adapter.priceFor(usage.model) : [0, 0];
  const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  return (inTok * pin + (usage.output_tokens || 0) * pout) / 1e6;
}
function estimateCost(model, promptChars, opts = {}) {
  const adapter = advisors.byId(opts.provider || DEFAULT_PROVIDER);
  const [pin, pout] = adapter.priceFor(model);
  const inTokens = Math.ceil((promptChars + PLAN_SYSTEM.length) / 4);
  return (inTokens * pin + EXPECTED_OUTPUT_TOKENS * pout) / 1e6;
}

// Append the schema to the system prompt for adapters that can't enforce it.
function systemFor(adapter, base, schema) {
  if (!schema || adapter.supportsSchema) return base;
  return base + '\n\nRespond with ONLY a single JSON object (no prose, no code fences) matching this JSON schema:\n' + JSON.stringify(schema);
}

async function generatePlan(apiKey, model, payload, opts = {}) {
  const adapter = advisors.byId(opts.provider || DEFAULT_PROVIDER) || advisors.byId(DEFAULT_PROVIDER);
  if (!apiKey && !adapter.needsBaseUrl) return { ok: false, status: 400, error: `Add your ${adapter.label} key in Settings first.` };
  const r = await adapter.generate({
    apiKey, baseUrl: opts.baseUrl, model,
    system: systemFor(adapter, PLAN_SYSTEM, PLAN_SCHEMA),
    prompt: buildPlanPrompt(payload), schema: PLAN_SCHEMA, maxTokens: PLAN_MAX_TOKENS,
  });
  if (r.error) return { ok: false, status: r.status || 502, error: r.error };
  let plan = null;
  try { plan = JSON.parse(r.text); } catch { plan = advisors.extractJson(r.text); }
  if (!plan) return { ok: false, status: 502, error: 'The model answered with something unreadable — try again.' };
  const usage = { ...(r.usage || {}), model };
  return { ok: true, plan, model, usage, costUsd: actualCost(adapter, usage) };
}

async function generateBriefing(apiKey, model, payload, opts = {}) {
  const adapter = advisors.byId(opts.provider || DEFAULT_PROVIDER) || advisors.byId(DEFAULT_PROVIDER);
  if (!apiKey && !adapter.needsBaseUrl) return { error: `Add your ${adapter.label} key in Settings first.` };
  const r = await adapter.generate({
    apiKey, baseUrl: opts.baseUrl, model,
    system: BRIEFING_SYSTEM, prompt: buildBriefingPrompt(payload), schema: null, maxTokens: BRIEFING_MAX_TOKENS,
  });
  if (r.error) return { error: r.error };
  if (!r.text || !r.text.trim()) return { error: 'The model returned an empty briefing — try again.' };
  return { text: r.text.trim() };
}

async function testKey(apiKey, model, opts = {}) {
  const adapter = advisors.byId(opts.provider || DEFAULT_PROVIDER) || advisors.byId(DEFAULT_PROVIDER);
  return adapter.testKey({ apiKey, baseUrl: opts.baseUrl });
}

module.exports = {
  PLANNER_MODELS: advisors.byId('anthropic').models, // back-compat: some callers still read this
  DEFAULT_MODEL: advisors.byId('anthropic').models[0].id,
  providers: advisors,
  getAdvisorConfig, testKey, estimateCost, actualCost,
  buildPlanPrompt, generatePlan, buildBriefingPrompt, generateBriefing,
};
```

Notes:
- `actualCost` now reads the price from `usage.model` (stamped in `generatePlan`), keeping the function provider-agnostic. Existing internal callers that passed `(model, usage)` are replaced by this path.
- `PLANNER_MODELS`/`DEFAULT_MODEL` are re-exported from the Anthropic adapter so any lingering reference keeps working until Task 7 updates the server.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/run-tests.js 2>&1 | grep -E "advisor: getAdvisorConfig migrates|advisor: generatePlan routes"`
Expected: PASS. Then run the whole suite and confirm the pre-existing advisor tests (briefing, plan, key-test) are still green:

Run: `node test/run-tests.js 2>&1 | tail -5`
Expected: `0 failing` (or the suite's existing pass line).

- [ ] **Step 5: Commit**

```bash
git add lib/advisor.js test/run-tests.js
git commit -m "feat: route advisor through provider adapters with lazy config migration"
```

---

## Task 7: Server payload, save, endpoints, routing

**Files:**
- Modify: `lib/server.js` (`settingsPayload`, `saveSettings`, route table, `/api/plan/generate`, `/api/briefing/generate`, `/api/settings/test`)
- Test: `test/run-tests.js`

- [ ] **Step 1: Write the failing test**

```js
check('server: /api/advisor exposes providers + never leaks key values', async () => {
  // Configure openai with a key, then read it back.
  await httpPost(PORT, '/api/advisor', { provider: 'openai', apiKey: 'sk-secret', model: 'gpt-4o' });
  const adv = await httpGet(PORT, '/api/advisor');
  assert.strictEqual(adv.provider, 'openai');
  const oai = adv.providers.find(p => p.id === 'openai');
  assert.strictEqual(oai.keySet, true);
  assert.ok(!JSON.stringify(adv).includes('sk-secret'), 'key value leaked to the page');
  const local = adv.providers.find(p => p.id === 'local');
  assert.strictEqual(local.needsBaseUrl, true);
});
```

(Use whatever HTTP helpers the suite already has for the in-process server; the settings/team tests near `test/run-tests.js:820` show the pattern. If none is factored, add tiny `httpGet`/`httpPost` helpers next to them.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run-tests.js 2>&1 | grep "server: /api/advisor"`
Expected: FAIL — route `/api/advisor` returns 404.

- [ ] **Step 3: Write minimal implementation**

In `lib/server.js`:

(a) Replace the advisor bits of `settingsPayload()` — swap the single-key fields for a provider list:

```js
function advisorPayload() {
  const config = getConfig();
  const raw = loadUserConfig();
  const adv = advisor.getAdvisorConfig(config);
  const stored = (raw.advisor && raw.advisor.providers) || {};
  const legacyAnthropicKey = raw.advisor && !stored.anthropic ? raw.advisor.apiKey : '';
  const providers = advisor.providers.list().map(a => {
    const pconf = stored[a.id] || {};
    const keySet = !!(pconf.apiKey || (a.id === 'anthropic' && legacyAnthropicKey) || (a.keyEnv || []).some(k => process.env[k]));
    return {
      id: a.id, label: a.label, needsBaseUrl: a.needsBaseUrl,
      models: a.models, keySet, baseUrl: a.needsBaseUrl ? (pconf.baseUrl || '') : undefined,
      model: pconf.model || (a.id === adv.provider ? adv.model : (a.models[0] ? a.models[0].id : '')),
    };
  });
  return { provider: adv.provider, model: adv.model, providers };
}
```

Keep `settingsPayload()` but replace its `hasKey/keySource/keyHint/model/models` fields with `advisor: advisorPayload()` (leave `intervalSec`, `targets`, `distill`, `team`, etc. untouched). Update the two current readers in `dashboard.js` in Task 8.

(b) In `saveSettings(body)`, replace the `apiKey`/`model` block with a provider-scoped writer:

```js
if (body.advisor && typeof body.advisor === 'object') {
  const b = body.advisor;
  raw.advisor = raw.advisor || {};
  raw.advisor.providers = raw.advisor.providers || {};
  const pid = advisor.providers.byId(b.provider) ? b.provider : (advisor.providers.byId(raw.advisor.provider) ? raw.advisor.provider : 'anthropic');
  if (b.provider !== undefined && advisor.providers.byId(b.provider)) raw.advisor.provider = b.provider;
  const p = raw.advisor.providers[pid] = { ...(raw.advisor.providers[pid] || {}) };
  if (b.apiKey !== undefined) p.apiKey = String(b.apiKey || '').trim();
  if (b.baseUrl !== undefined) p.baseUrl = String(b.baseUrl || '').trim();
  if (b.model !== undefined) {
    const adapter = advisor.providers.byId(pid);
    const ok = adapter.models.length ? adapter.models.some(m => m.id === b.model) : !!String(b.model || '').trim();
    if (ok) p.model = String(b.model).trim();
  }
}
```

(c) Add routes in the dispatch table (near `test/run-tests.js`'s server routes, i.e. `lib/server.js` around the `/api/settings` cases):

```js
} else if (req.method === 'GET' && url.pathname === '/api/advisor') {
  json(res, 200, advisorPayload());
} else if (req.method === 'POST' && url.pathname === '/api/advisor') {
  const body = await readBody(req);
  json(res, 200, saveSettings({ advisor: body }) && advisorPayload());
} else if (req.method === 'POST' && url.pathname === '/api/advisor/test') {
  const body = await readBody(req);
  const config = getConfig();
  const provider = advisor.providers.byId(body.provider) ? body.provider : advisor.getAdvisorConfig(config).provider;
  const adv = advisor.getAdvisorConfig({ ...config, advisor: { ...(config.advisor || {}), provider } });
  const key = String(body.apiKey || '').trim() || adv.apiKey;
  const baseUrl = String(body.baseUrl || '').trim() || adv.baseUrl;
  json(res, 200, await advisor.testKey(key, adv.model, { provider, baseUrl }));
}
```

(d) Route generation to the selected provider. In `/api/plan/generate` replace:

```js
const adv = advisor.getAdvisorConfig(config);
if (!adv.apiKey && !adv.baseUrl) return json(res, 400, { error: `Add your ${adv.adapter.label} key in Settings first.` });
const payload = planPayload(key, proj, config, goal);
const r = await advisor.generatePlan(adv.apiKey, adv.model, payload, { provider: adv.provider, baseUrl: adv.baseUrl });
```

In `/api/briefing/generate` replace:

```js
const adv = advisor.getAdvisorConfig(config);
if (!adv.apiKey && !adv.baseUrl) return json(res, 200, { degraded: true });
// ... unchanged teammate grouping ...
const r = await advisor.generateBriefing(adv.apiKey, adv.model, { since, until: now, teammates }, { provider: adv.provider, baseUrl: adv.baseUrl });
```

Leave the old `/api/settings/test` route working by delegating to the new provider-aware path (so nothing 500s if the client still calls it during rollout):

```js
} else if (req.method === 'POST' && url.pathname === '/api/settings/test') {
  const body = await readBody(req);
  const config = getConfig();
  const adv = advisor.getAdvisorConfig(config);
  const key = String(body.apiKey || '').trim() || adv.apiKey;
  json(res, 200, await advisor.testKey(key, adv.model, { provider: adv.provider, baseUrl: adv.baseUrl }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/run-tests.js 2>&1 | grep "server: /api/advisor"`
Expected: PASS. Then full suite:

Run: `node test/run-tests.js 2>&1 | tail -5`
Expected: no new failures. (If a pre-existing test asserted `settingsPayload().hasKey`, update it to read `settingsPayload().advisor.providers[...].keySet` — search the suite for `.hasKey` and `keySource`.)

- [ ] **Step 5: Commit**

```bash
git add lib/server.js test/run-tests.js
git commit -m "feat: multi-provider advisor server endpoints + routing"
```

---

## Task 8: Settings UI (provider selector + model dropdown + key/base URL)

**Files:**
- Modify: `lib/dashboard.js` (`settingsKeySection` at ~`lib/dashboard.js:3392`, its click/change handlers at ~`lib/dashboard.js:3463`, and the `loadSettings` fetch list at ~`lib/dashboard.js:3230`)
- Test: manual (client JS is not unit-tested); a server payload test already covers the data.

- [ ] **Step 1: Add the advisor payload to `loadSettings`**

`loadSettings` currently fetches `/api/settings`. Add `/api/advisor` to its `Promise.all` and stash it as `stAdvisor` (declare alongside `stSettings` at ~`lib/dashboard.js:3221`).

```js
// in the Promise.all array inside loadSettings():
fetch('/api/advisor').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
// after results land:
stAdvisor = res[/* new index */] || { provider: 'anthropic', providers: [] };
```

- [ ] **Step 2: Replace `settingsKeySection()` with a provider-aware section**

```js
function settingsKeySection() {
  var lbl = '<div style="' + STLABEL + '">AI briefings &amp; roadmaps</div>';
  var a = stAdvisor || { provider: 'anthropic', providers: [] };
  var cur = (a.providers || []).filter(function (p) { return p.id === a.provider; })[0] || (a.providers || [])[0] || { id: 'anthropic', models: [] };
  var provOpts = (a.providers || []).map(function (p) {
    return '<option value="' + esc(p.id) + '"' + (p.id === a.provider ? ' selected' : '') + '>' + esc(p.label) + (p.keySet ? ' ✓' : '') + '</option>';
  }).join('');
  var modelOpts = (cur.models || []).map(function (m) {
    var hint = (m.priceIn != null) ? ' — $' + m.priceIn + '/$' + m.priceOut + ' per 1M' : '';
    return '<option value="' + esc(m.id) + '"' + (m.id === cur.model ? ' selected' : '') + '>' + esc(m.label) + esc(hint) + '</option>';
  }).join('');
  var modelField = cur.needsBaseUrl
    ? '<input data-adv-model placeholder="model id (e.g. llama3.1)" value="' + esc(cur.model || '') + '" style="flex:1;height:40px;padding:0 12px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text);' + MONO + ';font-size:12px" />'
    : '<select data-adv-model style="flex:1;height:40px;padding:0 10px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12.5px">' + modelOpts + '</select>';
  var baseField = cur.needsBaseUrl
    ? '<input data-adv-base placeholder="http://localhost:11434/v1" value="' + esc(cur.baseUrl || '') + '" style="width:100%;height:40px;padding:0 12px;margin-top:9px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text);' + MONO + ';font-size:12px" />'
    : '';
  var keyPlaceholder = cur.id === 'anthropic' ? 'sk-ant-…' : cur.id === 'openai' ? 'sk-…' : cur.id === 'google' ? 'AI…' : 'optional token';
  return lbl +
    '<div style="' + STCARD + ';margin-bottom:34px;padding:16px 18px">' +
      '<div style="font-size:13px;color:var(--text2);margin-bottom:12px">Bring your own key. Used only to write your briefing and roadmaps &mdash; session memories never leave your team&rsquo;s sync.</div>' +
      '<div style="display:flex;gap:9px;align-items:center;margin-bottom:9px">' +
        '<select data-adv-provider style="flex:1;height:40px;padding:0 10px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12.5px">' + provOpts + '</select>' +
        modelField +
      '</div>' +
      baseField +
      '<div style="display:flex;gap:9px;align-items:center;margin-top:9px">' +
        '<input data-adv-key type="password" placeholder="' + keyPlaceholder + '" spellcheck="false" autocomplete="off" style="flex:1;height:44px;padding:0 13px;border-radius:12px;border:1px solid var(--border);background:var(--bg);color:var(--text);' + MONO + ';font-size:12px;outline:none" />' +
        '<span id="stKeyStatus" style="' + MONO + ';font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:' + (cur.keySet ? 'var(--green)' : 'var(--text3)') + ';font-weight:500;flex:none">' + (cur.keySet ? 'active' : 'no key') + '</span>' +
      '</div>' +
      '<div id="stKeyHint" style="font-size:11.5px;color:var(--text3);margin-top:9px">Switch providers any time &mdash; each keeps its own key and model.</div>' +
    '</div>';
}
```

- [ ] **Step 3: Wire the handlers**

In the settings `change` listener (near `lib/dashboard.js:3452`) add:

```js
var provSel = e.target.closest('[data-adv-provider]');
if (provSel) {
  fetch('/api/advisor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: provSel.value }) })
    .then(function () { loadSettings(); }).catch(function () { setPill(false); });
  return;
}
var modelSel = e.target.closest('[data-adv-model]');
if (modelSel) {
  fetch('/api/advisor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: modelSel.value }) })
    .then(function () { loadSettings(); }).catch(function () { setPill(false); });
  return;
}
```

In the settings blur/`focusout` handler that currently saves the key (near `lib/dashboard.js:3465`), change the selector from `[data-st-key]` to `[data-adv-key]`, include the current base URL, and POST to `/api/advisor/test` then `/api/advisor`:

```js
var input = e.target.closest('[data-adv-key]');
if (!input) return;
var v = input.value.trim();
var baseEl = settingsRoot.querySelector('[data-adv-base]');
var baseUrl = baseEl ? baseEl.value.trim() : '';
var status = document.getElementById('stKeyStatus');
if (!v && !baseUrl) {
  fetch('/api/advisor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: '' }) })
    .then(function () { loadSettings(); }).catch(function () { setPill(false); });
  return;
}
if (status) { status.textContent = 'testing'; status.style.color = 'var(--text3)'; }
fetch('/api/advisor/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: v, baseUrl: baseUrl }) })
  .then(function (r) { return r.json(); })
  .then(function (t) {
    if (!t.ok) { if (status) { status.textContent = 'rejected'; status.style.color = 'var(--red)'; } return; }
    return fetch('/api/advisor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: v, baseUrl: baseUrl }) }).then(function () { loadSettings(); });
  }).catch(function () { setPill(false); });
```

Also add a `focusout` save for `[data-adv-base]` mirroring the key save (so entering only a base URL for local persists). Reuse the same block, keyed off `[data-adv-base]`.

- [ ] **Step 4: Verify manually**

Run: rebuild/reinstall per the repo norm, open Settings, switch providers, confirm the model dropdown swaps, the base-URL field appears only for local, and the key field never shows a stored value.

Verify no server errors:
Run: `node test/run-tests.js 2>&1 | tail -3`
Expected: suite still green (this task is client-only; the guard is that nothing server-side regressed).

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard.js
git commit -m "feat: provider + model picker in Settings"
```

---

## Async tests

Several tests above are `async`. Confirm the suite's `check(name, fn)` awaits async `fn` (search `test/run-tests.js` for `await fn()` or an `async function check`). The existing `briefing: generateBriefing …` test at ~`test/run-tests.js:1673` is already async and passing, so the harness supports it — follow that exact pattern (define the `check(...)` inside the same `async` IIFE/section those tests live in). If a new test needs a port, use one not already claimed (17944 and 17948 are taken; 17960–17963 are used here).

---

## Self-Review

**Spec coverage (Feature 1 of the design doc):**
- Provider-adapter registry → Tasks 1–5. ✔
- Anthropic/OpenAI/Gemini/local adapters → Tasks 2/3/4/5. ✔
- Structured-output translation per vendor + tolerant local parse → adapter `generate` + `advisors.extractJson` + `systemFor` (Task 6). ✔
- Liveness/test-key per provider → each adapter's `testKey` + `/api/advisor/test` (Tasks 2–5, 7). ✔
- Cost per provider, local shows no estimate → `priceFor`/`actualCost`; local `[0,0]`/`priceIn:null` renders "—" (Tasks 5,6,8). ✔
- Config shape + lazy migration + env fallbacks → `getAdvisorConfig` (Task 6). ✔
- Server `/api/advisor` never leaks key values → `advisorPayload` returns `keySet` only (Task 7, asserted). ✔
- Settings UI provider-aware; local base-URL+model-id text → Task 8. ✔
- Curated dropdown governs cloud; local intrinsically text → Task 8 `modelField` branch. ✔

**Placeholder scan:** no TBD/TODO; every code step is complete. Model IDs and prices in the adapters are real, maintained values — update the `MODELS` arrays when vendors change; this is data, not a placeholder.

**Type consistency:** adapters uniformly return `{ text, usage:{ input_tokens, output_tokens } } | { error, status }`; `usage` is stamped with `model` in `generatePlan` before `actualCost` reads `priceFor(usage.model)`. `getAdvisorConfig` returns `{ provider, adapter, apiKey, baseUrl, model, source }`, consumed consistently in Task 7. `advisorPayload` provider objects use `{ id, label, needsBaseUrl, models, keySet, baseUrl?, model }`, consumed by Task 8.
