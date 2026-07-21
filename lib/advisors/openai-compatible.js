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
