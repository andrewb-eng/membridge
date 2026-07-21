'use strict';
// Copies lib/ into app/lib so the Electron app dir is self-contained
// (electron-builder two-package layout packages only what's inside app/).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dest = path.join(root, 'app', 'lib');
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(path.join(root, 'lib'), dest, { recursive: true });
console.log('app/lib refreshed from lib/');

// Copies bin/ into app/bin so the packaged app.asar carries the CLI entrypoint
// (bin/membridge.js) beside lib/. A wrapper on the user's PATH runs it via the
// app's own Electron-as-Node runtime — no system Node required.
const binDest = path.join(root, 'app', 'bin');
fs.rmSync(binDest, { recursive: true, force: true });
fs.cpSync(path.join(root, 'bin'), binDest, { recursive: true });
console.log('app/bin refreshed from bin/');

// The app version must always track the root package.json — a stale
// app/package.json version labels a fresh build as an old release.
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const appPkgPath = path.join(root, 'app', 'package.json');
const appPkg = JSON.parse(fs.readFileSync(appPkgPath, 'utf8'));
if (appPkg.version !== rootPkg.version) {
  appPkg.version = rootPkg.version;
  fs.writeFileSync(appPkgPath, JSON.stringify(appPkg, null, 2) + '\n');
  console.log(`app version synced to ${rootPkg.version}`);
}
