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
