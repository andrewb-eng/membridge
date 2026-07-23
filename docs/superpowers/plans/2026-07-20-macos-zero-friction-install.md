# Zero-friction macOS install (app + CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a single `curl | sh` command that installs `MemBridge.app` + the `membridge` CLI on macOS with no Gatekeeper warning, for $0.

**Architecture:** Deliver a pinned GitHub **release zip** (never quarantined, because `curl` doesn't set `com.apple.quarantine`). A hosted `install.sh` — pinned to an exact version + SHA-256 — downloads it, verifies the hash, unzips to `/Applications`, strips quarantine belt-and-suspenders, and installs a tiny CLI wrapper that runs the app-bundled `bin/membridge.js` via `ELECTRON_RUN_AS_NODE` (so no system Node is needed). The existing ad-hoc signature is kept.

**Tech Stack:** Electron + electron-builder, Node ≥18 (builtins only), POSIX `sh`.

## Global Constraints

- **No new runtime dependencies.** `gen-install.js` uses only Node builtins (`fs`, `path`, `crypto`). Zero-dependency ethos matches the existing test harness.
- **`install.sh` is POSIX `sh`**, macOS/arm64 target. No bash-isms.
- **Keep ad-hoc signing** in [`scripts/afterPack.js`](../../../scripts/afterPack.js) **unchanged** (`codesign --force --deep --sign -`) — required for arm64 to run at all.
- **Pin the exact release:** the installer embeds `version` + the zip's **SHA-256** and MUST verify the hash before installing; abort loudly on mismatch.
- **Bundle identity is fixed:** productName `MemBridge`, executable `Contents/MacOS/MemBridge`, appId `com.membridge.app`, CLI entry `Contents/Resources/app.asar/bin/membridge.js`.
- **CLI runs via `ELECTRON_RUN_AS_NODE=1`** against the app's own Electron binary — never assume system Node.
- **Release asset name is deterministic:** `MemBridge-${version}-arm64.zip`.
- **Repo is the source of truth:** `scripts/install/install.sh` is generated + committed; publishing to `membridge.me` is a copy step (documented in Task 4).
- Tests live in the existing harness [`test/run-tests.js`](../../../test/run-tests.js) using its `check('name', fn)` idiom; run the whole suite with `npm test`.

---

### Task 1: Bundle the CLI into the app

The packaged `app.asar` bundles `lib/` and `node_modules/libsodium*` but not `bin/membridge.js` (see the comment at [`lib/hooks.js:278`](../../../lib/hooks.js)). Copy `bin/` into `app/bin` during app prep so `app.asar/bin/membridge.js` ships beside `lib/` — exactly where [`lib/autostart.js:11`](../../../lib/autostart.js) already looks for it.

**Files:**
- Modify: `scripts/prepare-app.js`
- Modify: `.gitignore`
- Test: `test/run-tests.js` (add one `check`)

**Interfaces:**
- Consumes: nothing.
- Produces: build artifact `app/bin/membridge.js` inside the packed `app.asar` at `bin/membridge.js`. The CLI wrapper (Task 2) depends on this path.

- [ ] **Step 1: Write the failing test**

Insert this `check(...)` block in `test/run-tests.js` immediately after `setupFixtures();` (currently line 165) inside `main()`:

```javascript
  check('prepare-app bundles the CLI into app/bin so the packaged asar carries it', () => {
    const r = spawnSync('node', [path.join(__dirname, '..', 'scripts', 'prepare-app.js')], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `prepare-app failed: ${r.stderr}`);
    const binned = path.join(__dirname, '..', 'app', 'bin', 'membridge.js');
    assert.ok(fs.existsSync(binned), 'app/bin/membridge.js not created by prepare-app');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -F "prepare-app bundles the CLI"`
Expected: `FAIL  prepare-app bundles the CLI into app/bin ...` (because `prepare-app.js` does not yet copy `bin/`).

- [ ] **Step 3: Add the bin copy to `prepare-app.js`**

In `scripts/prepare-app.js`, after the existing `lib/` copy block (after line 11, the `console.log('app/lib refreshed from lib/')` line), insert:

```javascript
// Copies bin/ into app/bin so the packaged app.asar carries the CLI entrypoint
// (bin/membridge.js) beside lib/. A wrapper on the user's PATH runs it via the
// app's own Electron-as-Node runtime — no system Node required.
const binDest = path.join(root, 'app', 'bin');
fs.rmSync(binDest, { recursive: true, force: true });
fs.cpSync(path.join(root, 'bin'), binDest, { recursive: true });
console.log('app/bin refreshed from bin/');
```

- [ ] **Step 4: Ignore the new build artifact**

In `.gitignore`, directly below the existing `app/lib/` line (line 5), add:

```
app/bin/
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test 2>&1 | grep -F "prepare-app bundles the CLI"`
Expected: `ok    prepare-app bundles the CLI into app/bin ...`

- [ ] **Step 6: Verify the CLI actually runs from the app-bundle layout**

Run: `node scripts/prepare-app.js && ELECTRON_RUN_AS_NODE=1 node app/bin/membridge.js --version`
Expected: prints the version (e.g. `0.7.0`) with no `MODULE_NOT_FOUND` — proves `../lib`, `../package.json`, and `libsodium-wrappers` all resolve from the bundled layout. (Uses plain `node` here only to prove resolution; in production the Electron binary is the runtime.)

- [ ] **Step 7: Commit**

```bash
git add scripts/prepare-app.js .gitignore test/run-tests.js
git commit -m "feat: bundle the membridge CLI into the app package (app/bin)"
```

---

### Task 2: Pinned install script + generator

Create the installer (`install.sh.tmpl` → generated `install.sh`) and a Node generator that stamps the pinned version + SHA-256 in. The generator's two pure helpers are unit-tested; the shell content is guarded by a template-content assertion (the full end-to-end run is a manual step in Task 4's rollout).

**Files:**
- Create: `scripts/install/install.sh.tmpl`
- Create: `scripts/install/gen-install.js`
- Create: `scripts/install/install.sh` (generated output; committed so the raw URL works — regenerated each release)
- Test: `test/run-tests.js` (add three `check`s)

**Interfaces:**
- Consumes: the `app.asar/bin/membridge.js` path contract from Task 1; the deterministic asset name `MemBridge-${version}-arm64.zip` from Task 3.
- Produces:
  - `gen-install.sha256File(file: string): string` — hex SHA-256 of a file.
  - `gen-install.renderInstallScript(template: string, opts: { version: string, sha256: string }): string` — placeholders replaced.

- [ ] **Step 1: Write the failing tests**

Insert these three `check(...)` blocks in `test/run-tests.js` right after the Task 1 check:

```javascript
  check('gen-install: sha256File hashes file contents', () => {
    const gen = require('../scripts/install/gen-install');
    const f = path.join(ROOT, 'fixture.zip');
    fs.writeFileSync(f, 'hello'); // sha256("hello") is a known constant
    assert.strictEqual(gen.sha256File(f),
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
  check('gen-install: renderInstallScript stamps version + sha256 and leaves no placeholders', () => {
    const gen = require('../scripts/install/gen-install');
    const out = gen.renderInstallScript('V=__MEMBRIDGE_VERSION__ H=__MEMBRIDGE_SHA256__',
      { version: '9.9.9', sha256: 'abc123' });
    assert.strictEqual(out, 'V=9.9.9 H=abc123');
    assert.ok(!out.includes('__MEMBRIDGE_'), 'placeholders left unstamped');
  });
  check('install.sh template carries the safety-critical steps', () => {
    const tmpl = read(path.join(__dirname, '..', 'scripts', 'install', 'install.sh.tmpl'));
    assert.ok(tmpl.includes('com.apple.quarantine'), 'quarantine strip missing');
    assert.ok(tmpl.includes('ELECTRON_RUN_AS_NODE=1'), 'CLI wrapper runtime missing');
    assert.ok(tmpl.includes('shasum -a 256'), 'sha256 verification missing');
    assert.ok(tmpl.includes('__MEMBRIDGE_VERSION__') && tmpl.includes('__MEMBRIDGE_SHA256__'),
      'pin placeholders missing');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -F "gen-install:"`
Expected: both `gen-install:` checks FAIL with `Cannot find module '../scripts/install/gen-install'`, and the template check FAILs (file absent).

- [ ] **Step 3: Create the install script template**

Create `scripts/install/install.sh.tmpl` with exactly this content:

```sh
#!/bin/sh
# MemBridge macOS installer — installs the app + `membridge` CLI, no Gatekeeper warning.
# Pinned to one release (version + SHA-256) by scripts/install/gen-install.js.
#   curl -fsSL https://membridge.me/install.sh | sh
#   curl -fsSL https://membridge.me/install.sh | sh -s -- --dry-run
set -eu

VERSION="__MEMBRIDGE_VERSION__"
SHA256="__MEMBRIDGE_SHA256__"
REPO="MembridgeAi/membridge"
APP_NAME="MemBridge"
APP_DEST="/Applications/${APP_NAME}.app"
CLI_DEST="/usr/local/bin/membridge"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

say() { printf '\033[1;34mmembridge\033[0m %s\n' "$1"; }
die() { printf '\033[1;31mmembridge error\033[0m %s\n' "$1" >&2; exit 1; }
run() { if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else eval "$@"; fi; }

# 1. Preflight
[ "$(uname -s)" = "Darwin" ] || die "macOS only. On Linux/Windows: npm i -g membridge"
[ "$(uname -m)" = "arm64" ] || die "No prebuilt app for $(uname -m) yet. On Intel Macs: npm i -g membridge"
command -v curl   >/dev/null 2>&1 || die "curl is required."
command -v shasum >/dev/null 2>&1 || die "shasum is required."

ASSET="${APP_NAME}-${VERSION}-arm64.zip"
URL="https://github.com/${REPO}/releases/download/v${VERSION}/${ASSET}"

# 2. Download (curl never sets com.apple.quarantine — this is the whole point)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say "Downloading ${APP_NAME} ${VERSION}..."
run "curl -fsSL '$URL' -o '$TMP/$ASSET'"

# 3. Verify the pin
if [ "$DRY_RUN" != 1 ]; then
  GOT="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
  [ "$GOT" = "$SHA256" ] || die "checksum mismatch (expected $SHA256, got $GOT). Refusing to install."
  say "Checksum verified."
fi

# 4. Quit any running instance so the bundle can be replaced
osascript -e "quit app \"${APP_NAME}\"" >/dev/null 2>&1 || true
pkill -f "${APP_NAME}.app/Contents/MacOS/${APP_NAME}" >/dev/null 2>&1 || true

# 5. Install the app
say "Installing to ${APP_DEST}..."
run "rm -rf '$APP_DEST'"
run "mkdir -p '$TMP/unzip'"
run "ditto -x -k '$TMP/$ASSET' '$TMP/unzip'"
run "mv '$TMP/unzip/${APP_NAME}.app' '$APP_DEST'"

# 6. Strip quarantine (belt-and-suspenders; curl already avoids it)
run "xattr -dr com.apple.quarantine '$APP_DEST' 2>/dev/null || true"

# 7. Install the CLI wrapper (runs the bundled CLI via the app's Electron-as-Node)
if [ "$DRY_RUN" = 1 ]; then
  printf '  [dry-run] write %s (Electron-as-Node wrapper)\n' "$CLI_DEST"
else
  WRAPPER="$TMP/membridge"
  cat > "$WRAPPER" <<EOF
#!/bin/sh
APP="${APP_DEST}"
exec env ELECTRON_RUN_AS_NODE=1 "\$APP/Contents/MacOS/${APP_NAME}" "\$APP/Contents/Resources/app.asar/bin/membridge.js" "\$@"
EOF
  chmod +x "$WRAPPER"
  BIN_DIR="$(dirname "$CLI_DEST")"
  if mkdir -p "$BIN_DIR" 2>/dev/null && [ -w "$BIN_DIR" ]; then
    cp "$WRAPPER" "$CLI_DEST" && chmod +x "$CLI_DEST"
    say "CLI installed at ${CLI_DEST}"
  elif sudo mkdir -p "$BIN_DIR" && sudo cp "$WRAPPER" "$CLI_DEST" && sudo chmod +x "$CLI_DEST"; then
    say "CLI installed at ${CLI_DEST}"
  else
    say "Couldn't install the CLI automatically. Add it later with:"
    cat <<MANUAL
  sudo mkdir -p ${BIN_DIR}
  sudo tee ${CLI_DEST} >/dev/null <<'SH'
#!/bin/sh
APP="${APP_DEST}"
exec env ELECTRON_RUN_AS_NODE=1 "\$APP/Contents/MacOS/${APP_NAME}" "\$APP/Contents/Resources/app.asar/bin/membridge.js" "\$@"
SH
  sudo chmod +x ${CLI_DEST}
MANUAL
  fi
fi

# 8. Launch + report
run "open '$APP_DEST'"
say "Done. ${APP_NAME} is installed and opens with no warning."
if command -v membridge >/dev/null 2>&1; then
  say "CLI ready: $(command -v membridge)"
else
  say "CLI installed — open a new terminal (ensure /usr/local/bin is on PATH) to use 'membridge'."
fi
```

- [ ] **Step 4: Create the generator**

Create `scripts/install/gen-install.js` with exactly this content:

```javascript
'use strict';
// Stamps a pinned release (version + SHA-256 of the built zip) into the macOS
// install script. Run after `npm run dist:mac`:
//   node scripts/install/gen-install.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');

/** Hex SHA-256 digest of a file's bytes. */
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Replace the pin placeholders in the template with concrete values. */
function renderInstallScript(template, { version, sha256 }) {
  return template
    .replace(/__MEMBRIDGE_VERSION__/g, version)
    .replace(/__MEMBRIDGE_SHA256__/g, sha256);
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  const asset = `MemBridge-${version}-arm64.zip`;
  const zipPath = path.join(ROOT, 'dist', asset);
  if (!fs.existsSync(zipPath)) {
    console.error(`Built zip not found: ${zipPath}\nRun "npm run dist:mac" first.`);
    process.exit(1);
  }
  const sha256 = sha256File(zipPath);
  const tmpl = fs.readFileSync(path.join(__dirname, 'install.sh.tmpl'), 'utf8');
  const out = renderInstallScript(tmpl, { version, sha256 });
  const outPath = path.join(__dirname, 'install.sh');
  fs.writeFileSync(outPath, out);
  fs.chmodSync(outPath, 0o755);
  console.log(`Wrote ${outPath}\n  version ${version}\n  sha256  ${sha256}`);
}

if (require.main === module) main();
module.exports = { sha256File, renderInstallScript };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -F -e "gen-install:" -e "install.sh template"`
Expected: all three checks print `ok`.

- [ ] **Step 6: Seed a committed `install.sh` (unpinned placeholder for now)**

Until the first release zip exists, commit a copy of the template as `install.sh` so the path is tracked; the real pin lands during rollout (Task 4). Run:

```bash
cp scripts/install/install.sh.tmpl scripts/install/install.sh && chmod +x scripts/install/install.sh
```

- [ ] **Step 7: Commit**

```bash
git add scripts/install/ test/run-tests.js
git commit -m "feat: pinned macOS install script + SHA-256 generator"
```

---

### Task 3: Deterministic arm64 zip build config

Make electron-builder emit a single, predictably-named zip so the installer URL is stable, and drop the DMG target (curl/zip-only per the spec).

**Files:**
- Modify: `package.json` (the `build.mac` block)
- Test: `test/run-tests.js` (add one `check`)

**Interfaces:**
- Consumes: nothing.
- Produces: release asset `MemBridge-${version}-arm64.zip` under `dist/`, consumed by `gen-install.js` (Task 2) and the installer URL (Task 2 template).

- [ ] **Step 1: Write the failing test**

Insert this `check(...)` in `test/run-tests.js` after the Task 2 checks:

```javascript
  check('build config ships an arm64 zip with a deterministic name for the installer URL', () => {
    const pkg = JSON.parse(read(path.join(__dirname, '..', 'package.json')));
    assert.deepStrictEqual(pkg.build.mac.target, ['zip'], 'mac target should be zip-only');
    assert.strictEqual(pkg.build.mac.artifactName, 'MemBridge-${version}-${arch}.${ext}',
      'artifactName must be deterministic so install.sh can build the release URL');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -F "deterministic name for the installer URL"`
Expected: `FAIL` — current target is `["dmg","zip"]` and no `artifactName` is set.

- [ ] **Step 3: Update `build.mac` in `package.json`**

Replace the current `mac` block (package.json lines 46–53) with:

```json
    "mac": {
      "target": [
        "zip"
      ],
      "artifactName": "MemBridge-${version}-${arch}.${ext}",
      "category": "public.app-category.developer-tools",
      "icon": "app/assets/icon.png"
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -F "deterministic name for the installer URL"`
Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add package.json test/run-tests.js
git commit -m "build: emit a single deterministic arm64 zip for the installer"
```

---

### Task 4: README one-liner + release docs, then a real end-to-end pin

Document the install for users, document the release flow for maintainers, and perform the first real build → generate → verify so the committed `install.sh` is genuinely pinned.

**Files:**
- Modify: `README.md` (Quick start step 1, ~lines 137–142)
- Create: `docs/releasing-macos.md`
- Modify: `scripts/install/install.sh` (regenerated with the real pin)

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: user-facing docs + a truly pinned `install.sh`.

- [ ] **Step 1: Update the README Quick start install step**

Replace README lines 137–142 (the current `Install the app (macOS)... Builds are unsigned for now: right-click → Open` bullet) with:

```markdown
1. **Install the app + CLI** (macOS, Apple Silicon) with one command. It
   downloads the pinned release, installs `MemBridge.app` to `/Applications`
   and the `membridge` CLI to `/usr/local/bin`, and launches with **no
   Gatekeeper warning**:

   ```sh
   curl -fsSL https://membridge.me/install.sh | sh
   ```

   The app opens with zero prompts — `curl` downloads without the
   `com.apple.quarantine` flag that triggers Gatekeeper. Installing the CLI
   into `/usr/local/bin` may ask for your password once. Prefer to read before
   you run? `curl -fsSL https://membridge.me/install.sh -o install.sh` and
   inspect it — it verifies the download's SHA-256 before touching your disk.
   On Intel Macs, Windows, or a server, use [the CLI](#the-cli) via npm instead.
```

- [ ] **Step 2: Create the maintainer release doc**

Create `docs/releasing-macos.md` with exactly this content:

```markdown
# Releasing the macOS installer

The `curl | sh` installer is pinned to one release (version + SHA-256). Every
release regenerates and republishes `install.sh`.

1. Bump `version` in `package.json` (and let `scripts/prepare-app.js` sync
   `app/package.json` on the next build).
2. Build the app — this runs `prepare-app.js` (which bundles `bin/` into the
   app) and produces `dist/MemBridge-<version>-arm64.zip`:
   ```sh
   npm run dist:mac
   ```
3. Stamp the pin into `scripts/install/install.sh`:
   ```sh
   node scripts/install/gen-install.js
   ```
   It prints the version + SHA-256 it embedded.
4. Create the GitHub release tagged `v<version>` and upload
   `dist/MemBridge-<version>-arm64.zip` as a release asset. The asset name must
   match `MemBridge-<version>-arm64.zip` (the installer builds the URL from it).
5. Publish `install.sh` so `https://membridge.me/install.sh` serves it: copy
   `scripts/install/install.sh` to the root of the `mmelika/membridge-site`
   repo as `install.sh`, commit, and push (GitHub Pages serves it). The raw
   fallback URL, which works without the site repo, is
   `https://raw.githubusercontent.com/MembridgeAi/membridge/master/scripts/install/install.sh`.
6. Commit the regenerated `scripts/install/install.sh` in this repo.
7. Smoke-test on a clean Apple Silicon machine:
   ```sh
   curl -fsSL https://membridge.me/install.sh | sh
   membridge --version
   ```
   Confirm zero Gatekeeper prompts on the app.
```

- [ ] **Step 3: Verify the docs contain no dangling promises**

Run: `grep -n "membridge.me/install.sh" README.md docs/releasing-macos.md`
Expected: both files reference the URL; README has the one-liner, the doc has the publish step that makes it live.

- [ ] **Step 4: Perform the first real pin (manual, on an Apple Silicon Mac)**

Run:
```sh
npm run dist:mac && node scripts/install/gen-install.js && shellcheck scripts/install/install.sh
```
Expected: a `dist/MemBridge-<version>-arm64.zip` is produced; `gen-install.js` prints a real version + SHA-256; `shellcheck` reports no errors on the generated script. (If `shellcheck` isn't installed: `brew install shellcheck`.)

- [ ] **Step 5: Full end-to-end smoke test (manual)**

Run the generated installer against the local build without publishing, to prove the flow end-to-end:
```sh
sh scripts/install/install.sh --dry-run
```
Expected: prints each planned action (download URL with the real version, checksum step, unzip to `/Applications`, quarantine strip, CLI wrapper write, `open`) and touches nothing. Then, after the GitHub release asset is uploaded (Step 4 of `docs/releasing-macos.md`), run the real one-liner on a clean machine and confirm: no Gatekeeper prompt, app launches, `membridge --version` works in a fresh shell.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/releasing-macos.md scripts/install/install.sh
git commit -m "docs: curl one-liner install + macOS release flow, real pin"
```

---

## Self-Review

**Spec coverage:**
- Ad-hoc signing kept (Global Constraints + untouched `afterPack.js`) — spec Component 5. ✓
- curl/zip-only delivery, no DMG (Task 3 drops `dmg`; Task 2 installer) — spec Architecture. ✓
- Pinned version + SHA-256 verification (Task 2 template step 3 + generator) — spec Goals/Component 4. ✓
- CLI bundled into `app.asar` (Task 1) run via `ELECTRON_RUN_AS_NODE` wrapper (Task 2 step 7) — spec Components 1–2. ✓
- `/usr/local/bin` sudo fallback + never abort app install (Task 2 template step 7) — spec Risks. ✓
- Quit running instance before replace (Task 2 template step 4) — spec Risks. ✓
- Deterministic artifact name (Task 3) — spec Component 4. ✓
- Hosting at membridge.me + raw fallback + release regen (Task 4 doc) — spec Component 4. ✓
- README updated (Task 4) — spec Component 7 (curl-only equivalent). ✓
- Intel/x64 preflight fallback (Task 2 template step 1) — spec Non-goals/Risks. ✓
- `--dry-run` (Task 2 template + Task 4 step 5) — spec Component 3. ✓
- Tests: prepare-app bundling, gen-install helpers, template safety, build config (Tasks 1–3) — spec Testing. ✓

**Placeholder scan:** No "TBD/TODO/handle edge cases" — every code step carries full content. The `__MEMBRIDGE_*__` tokens are intentional template placeholders (asserted present in Task 2, stamped out by the generator), not plan gaps.

**Type/name consistency:** `sha256File` and `renderInstallScript` are defined in Task 2's generator and used with the same signatures in Task 2's tests. Asset name `MemBridge-${version}-arm64.zip` is identical across the installer template (Task 2), the generator (Task 2), the build `artifactName` (Task 3), and the release doc (Task 4). Wrapper path `Contents/Resources/app.asar/bin/membridge.js` matches Task 1's produced artifact. App executable `Contents/MacOS/MemBridge` matches the built bundle.
