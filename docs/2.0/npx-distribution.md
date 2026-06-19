# 2.0.0 Plan 4 — `npx modulus` distribution

Make an everyday person able to go from nothing to chatting with **one command**
— `npx modulus` — without cloning the repo (North Star #1). This plan is
packaging + CLI bootstrap only; it shares no files with Plans 1–3.

## The hard part: `better-sqlite3` native binary

This dev box can't reinstall `node_modules` because `better-sqlite3` has no
prebuilt binary for its Node/OS and there's no C++ toolchain — `node_modules` was
copied from GurneyAgent (see CLAUDE.md). That same wall is what most `npx` users
would hit **unless** the published install pulls a prebuilt binary.

`better-sqlite3` ships prebuilt binaries via `prebuild-install`, which runs in its
npm install script and fetches the binary matching the user's Node ABI + platform.
A _published_ `npx` install therefore generally works where the copied-tree dev box
does not — but only for platform/ABI combos that have a prebuild. **The plan must
verify and pin the matrix**, especially **arm64 (the Pi)**:

- Confirm the pinned `better-sqlite3` version publishes prebuilds for Node
  20 + 22 across `{win32, darwin, linux} × {x64, arm64}`.
- Pin that version (don't float `^`) so a future release can't silently drop a
  prebuild the Pi needs.
- Provide a **clear fallback message** when no prebuild + no toolchain is present,
  pointing at the desktop app (Windows) or a documented build-tools install
  (linux/mac) — fail loud and helpful, never a raw node-gyp stack.

## package.json for publish

- Drop `"private": true` (or publish under a scope).
- **Decide the npm name** — `modulus` is likely taken; recommend a scope
  (`@modulus/cli` or similar) or an available bare name. The npx target is whatever
  name is published. _(Open decision — see below.)_
- `"files"` allowlist so the tarball is lean and complete: `dist/`, `scripts/copy-*.mjs`,
  `src/storage/migrations/**` (or the copied `dist` migrations), the panel `web`
  assets, `skills/`, `modules/` (first-party modules load as `.ts` via tsx, so they
  must ship), `README.md`, `LICENSE`, `CHANGELOG.md`.
- `"prepublishOnly": "npm run build"` so a publish always ships a fresh `dist/`.
  **No `postinstall`** — it would run on every end-user install and risks the very
  native-build trap we're avoiding; ship `dist/` prebuilt instead.
- Keep `"bin": { "modulus": "./dist/cli/index.js" }` (already present) and
  `"engines": { "node": ">=20" }`.
- Confirm runtime deps that the CLI needs at load are `dependencies` not
  `devDependencies` — notably `tsx` (the CLI calls `register()` and dynamically
  imports `.ts` module/skill sources and the abilitytest runner). It already is;
  re-verify after the `files` trim that nothing required is excluded.

## First-run UX over npx

`~/.modulus/` persists config + DB across `npx` invocations, so state survives. The
flow:

- `npx modulus start` boots the daemon; with no config it triggers the existing
  UI-first onboarding (panel opens for Telegram token, model pull, tier detect).
- Optionally make bare `npx modulus` (no subcommand) run `start` when sensible
  while keeping `--help`/`--version` intact; otherwise document `npx modulus start`
  as the entry. Keep it minimal — a small `src/cli/index.ts` default-action tweak,
  not a new command tree.
- Print a one-line hint after first boot that `npx` is for trying it and a global
  install (`npm i -g <name>`) or the desktop app is the durable path.

## Verification

- **Pack smoke** — new `scripts/pack-smoke.mjs`: `npm pack`, install the tarball
  into a temp dir, and run `modulus --version` + `modulus status --json` to prove
  the _published artifact_ boots from `dist/` with no repo present.
- **CI matrix** — a workflow running pack-smoke on `{win, mac, linux} × Node
{20, 22}`, including a linux-arm64 leg if the runner is available (the Pi proxy),
  asserting `better-sqlite3` loads.
- **`npm publish --dry-run`** — audit the final tarball file list (no `node_modules`,
  no `desktop/publish`, no `.modulus` data, no test fixtures).

## Files touched

- `package.json` (publish metadata, `files`, scripts, name).
- `src/cli/index.ts` (optional default-action + first-run hint).
- `scripts/pack-smoke.mjs` (new) + `.github/workflows/*` (new pack-smoke job).
- `docs/` getting-started + `README.md` quickstart (`npx modulus`, Pi/arm64 note).
- `.npmignore` only if `files` proves insufficient.

## Open decision (needs maintainer)

- **npm package name + publish scope** — bare name vs `@scope/...`; this sets the
  exact `npx <name>` command. Recommend resolving before Phase A so the docs and
  smoke test use the real name.

## Phases

- **A.** package.json publish readiness (drop private, `files`, `prepublishOnly`,
  name) → `npm pack` yields a clean, complete tarball (audit contents).
- **B.** Pin + verify the `better-sqlite3` prebuild matrix (incl. arm64) + the
  loud fallback message.
- **C.** `scripts/pack-smoke.mjs` + CI matrix job.
- **D.** CLI first-run polish + `docs`/`README` quickstart.
- **E.** `npm publish --dry-run` checklist. **The real publish is a gated release
  step** (like the deferred version bump), not part of the merge.

## Success criteria

- On a clean machine with Node ≥20 and **no toolchain**, `npx modulus start`
  installs, fetches the `better-sqlite3` prebuild, boots, and opens onboarding —
  zero compilation.
- The pack-smoke CI leg is green on win/mac/linux × Node 20/22 (+ arm64 where
  available).
- A platform with no prebuild + no toolchain gets a friendly, actionable error,
  not a node-gyp crash.

## Status (implemented — Phases A–E)

**Done, full gate green** (999 tests, 996 pass / 3 skips; lint + typecheck +
typecheck:modules clean). **Decided name: `modulus-agent`** (`modulus` is taken on
npm at v6.5.0); the local binary stays `modulus`, with a `modulus-agent` bin alias
so `npx modulus-agent start` resolves unambiguously.

- **A** `package.json` publish-ready: name `modulus-agent`, dual `bin`, `files`
  allowlist with `!` negations (drops tests/sourcemaps/tsconfig — tarball trimmed
  500 files / 5.8 MB, audited via `npm pack --dry-run`), `prepublishOnly`,
  `keywords`, `private` removed. `package-lock.json` re-synced
  (`npm install --package-lock-only`) to the new name/version/pin.
- **B** `better-sqlite3` pinned to exact `12.9.0`; friendly native-load fallback in
  `src/cli/native-hint.ts` (`betterSqliteHint`) wired into the CLI's `fail()` — a
  NODE_MODULE_VERSION/bindings/ELF error now prints actionable guidance, not a raw
  node stack. 5 tests. (Live arm64 prebuild verification is the CI's job;
  `macos-latest` already covers darwin-arm64.)
- **C** `scripts/pack-smoke.mjs` (`npm pack` → install into a temp project →
  assert `--version` + load the native binary) + `.github/workflows/pack-smoke.yml`
  (linux/win/mac × Node 20/22, plus an optional `ubuntu-24.04-arm` Pi-proxy leg).
- **D** CLI quick-start help footer; README quickstart rewritten npx-first with the
  Pi/arm64 prebuild note.
- **E** `npm publish --dry-run` validated (would publish `modulus-agent@1.5.0`).

**Remaining (gated release steps, not code):** the real `npm publish` (and any
2.0.0 version bump) — deliberate, owner-run. `pack-smoke.mjs` wasn't run end-to-end
on the dev box because installing `better-sqlite3` there hits the very native-build
wall this plan addresses; it runs in CI.
