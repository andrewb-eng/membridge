'use strict';

// Pure feed read-model. Transforms already-fetched arrays (no fs/network):
// local .membridge entries (memorydb.buildEntries) and team_feed RPC rows are
// normalized to one shape, merged newest-first, deduped where the same pushed
// work appears in both, and paginated with an approximate cross-source cursor.

function normalizeLocal(e, meta) {
  return {
    origin: 'local',
    ts: e.ts || '',
    self: true,
    author: 'You',
    authorId: null,
    source: e.source || '',
    project: meta.projectName || '',
    projectPath: meta.projectPath || null,
    projectId: meta.projectId || null,
    ask: e.ask || '',
    summary: e.summary || null,
    distilled: !!e.distilled,
    files: Array.isArray(e.files) ? e.files : [],
    tasks: e.tasks || null,
    cursor: null,
  };
}

module.exports = { normalizeLocal };
