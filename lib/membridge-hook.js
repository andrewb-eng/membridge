'use strict';
// Hook entry point, invoked by the commands setup-hooks writes:
//   [ELECTRON_RUN_AS_NODE=1] "<runtime>" "<this file>"               // Claude Code Stop hook
//   [ELECTRON_RUN_AS_NODE=1] "<runtime>" "<this file>" post-commit   // git post-commit hook
// It lives in lib/ (not bin/) because the packaged Electron app ships only
// lib/ inside its asar — this file therefore exists in every install layout
// (git checkout, npm -g, app.asar) at a path derivable from __dirname.
// Behavior matches `membridge hook stop` / `membridge hook post-commit`.
const hooks = require('./hooks');
if (process.argv[2] === 'post-commit') hooks.runPostCommit();
else hooks.runStop();
