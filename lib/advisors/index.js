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
