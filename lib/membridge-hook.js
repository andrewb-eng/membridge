'use strict';
// Claude Code Stop-hook entry point, invoked by the command setup-hooks writes:
//   [ELECTRON_RUN_AS_NODE=1] "<runtime binary>" "<abs path to this file>"
// It lives in lib/ (not bin/) because the packaged Electron app ships only
// lib/ inside its asar — this file therefore exists in every install layout
// (git checkout, npm -g, app.asar) at a path derivable from __dirname.
// Behavior is identical to `membridge hook stop`.
// argv dispatch: `append <target> '<json>'` writes one validated summary
// line (see hooks.runAppend); anything else is the Stop-hook entry point.
const argv = process.argv.slice(2);
if (argv[0] === 'append') require('./hooks').runAppend(argv.slice(1));
else require('./hooks').runStop();
