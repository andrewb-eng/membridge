'use strict';
// Ad-hoc code-signs the mac app bundle after electron-builder packs it, before
// it's zipped/dmg'd. Without any signature, Apple Silicon's Gatekeeper refuses
// to run the app at all and reports it as "damaged" rather than the normal
// unsigned-app warning. Ad-hoc signing (identity "-") fixes that; the app
// still isn't notarized, so first launch needs right-click > Open.
const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
