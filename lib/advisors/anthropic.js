'use strict';
// Anthropic adapter — ported from the original single-provider lib/advisor.js.
// Same endpoints, same auth header, same retry/timeout/error-string behavior.
// advisor.js is not yet rewired to use this (see plan Task 6); this file is
// additive only.

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
