# macOS Support: Build Target, CI Release Workflow, and Docs

**Date:** 2026-06-30
**Status:** Approved (design)
**Author:** Hunain Parekh (contributor)
**Upstream:** `ah2k-dev/echolect` — delivered via fork + pull request.

## Problem

Echolect ships for Linux and Windows only. The `electron-builder.yml` config has
no `mac` target, so `npm run package` produces nothing on macOS, the README lists
only Linux/Windows, and there is no CI path for a maintainer to publish a Mac build.
The goal: make the project officially buildable and runnable on macOS, and let the
maintainer publish a Mac build by pushing a tag — without owning a Mac.

## Scope

In scope:
1. A macOS target in `electron-builder.yml` (dmg + zip, arm64).
2. A GitHub Actions workflow that build-verifies on PRs and auto-publishes the Mac
   build to the matching GitHub Release on `v*` tags.
3. README updates documenting macOS install, the unsigned-app Gatekeeper workaround,
   and the new CI path.

Out of scope (flagged as PR follow-ups, not implemented):
- **Code signing / notarization** — requires the maintainer's paid Apple Developer ID
  certificate and repository secrets, which a contributor cannot provide. Builds are
  unsigned; users bypass Gatekeeper manually.
- **Windows / Linux CI changes** — the existing AppVeyor Windows pipeline is left
  untouched. No unified multi-OS workflow.

## Constraints & Context

- Native module `better-sqlite3` cannot be cross-compiled; it must be built on a real
  macOS runner. `npm ci`'s `postinstall` hook runs `electron-rebuild`, which handles this.
- Target architecture is **arm64 (Apple Silicon)**, matching the verified local build and
  the `macos-14` GitHub-hosted runner.
- `electron-builder.yml` already declares `publish: github`, so CI only needs to pass the
  right `--publish` flag and a token.

## Design

### 1. `electron-builder.yml` — Mac target

```yaml
mac:
  icon: build/icon.png
  category: public.app-category.productivity
  target:
    - dmg
    - zip
```

- Produces `Echolect-<version>-arm64.dmg` and `Echolect-<version>-arm64-mac.zip` in `release/`.
- `build/icon.png` (512×512) is auto-converted to `.icns` by electron-builder.
- No `identity` key → unsigned build (intentional; see out-of-scope).
- The existing top-level `publish: github` stanza is reused; no change needed there.

### 2. `.github/workflows/release-mac.yml` — CI

One workflow, two jobs distinguished by trigger.

**Triggers:**
- `pull_request` and `workflow_dispatch` → build-verify (no publish).
- `push` with `tags: ['v*']` → build and publish to the matching GitHub Release.

**Runner / toolchain:**
- `runs-on: macos-14` (Apple Silicon → arm64).
- Node 20 via `actions/setup-node@v4` (matches local `v20.20.2`), `cache: npm`.

**Build steps (shared):**
1. `actions/checkout@v4`
2. `actions/setup-node@v4` (Node 20)
3. `npm ci` — installs deps; `postinstall` runs `electron-rebuild` for `better-sqlite3`.
4. `npm run build` — renderer bundle (tsc + vite).
5. `npm run build:electron` — main + preload.

**Publish behavior (per trigger):**
- PR / dispatch: `npx electron-builder --mac --publish never`, then
  `actions/upload-artifact@v4` uploads `release/*.dmg` and `release/*.zip` so reviewers
  can download and test the build. No secrets required (works for fork PRs).
- Tag push: `npx electron-builder --mac --publish always` with
  `env: GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` and job-level
  `permissions: contents: write`. electron-builder uploads the `.dmg`/`.zip` to the
  GitHub Release matching the tag.

The workflow calls `electron-builder` directly rather than `npm run package`, so the
`--publish` flag is explicit and differs per trigger.

### 3. `README.md` updates

- **Platform badge:** `Linux · Windows` → `macOS · Linux · Windows`.
- **Install (user) section:** add a macOS entry — download `Echolect-*-arm64.dmg`, drag to
  Applications. Add the Gatekeeper note: the build is unsigned, so first launch is via
  right-click → **Open**, or
  `xattr -dr com.apple.quarantine /Applications/Echolect.app`.
- **Build & package `<details>`:** note that on macOS `npm run package` produces a `.dmg`
  and `.zip`; that Mac releases are built by `.github/workflows/release-mac.yml` (the macOS
  counterpart to the Windows AppVeyor pipeline); and that builds are currently unsigned.

## Components & Boundaries

| Unit | Purpose | Depends on |
| --- | --- | --- |
| `electron-builder.yml` `mac:` block | Declares how the `.dmg`/`.zip` are produced | `build/icon.png`, existing `publish: github` |
| `release-mac.yml` build-verify job | Proves the Mac build compiles on every PR | `package.json` scripts, macos runner |
| `release-mac.yml` release job | Publishes Mac artifacts on `v*` tags | `GITHUB_TOKEN`, `publish: github` |
| README macOS sections | Tells users/maintainers how to install/run/build on Mac | the above existing |

Each unit is independently verifiable: the config via local `npm run package`, the CI via a
PR run, the docs by reading.

## Verification

- **Local package:** `npm run package` on macOS arm64 — already run; produced a clean
  `Echolect-0.1.0-arm64.dmg` (98 MB) and `-mac.zip` (95 MB). ✅
- **CI build-verify:** the `pull_request` job builds the same `.dmg` on `macos-14` and
  uploads it as an artifact, validating the workflow inside the PR itself.
- **Existing tests:** `npm test` (Vitest) is unaffected — this change touches only config,
  CI, and docs, no application source.
- **Release path:** exercised when the maintainer pushes a `v*` tag after merge (cannot be
  tested by the contributor pre-merge; relied upon via the standard `GITHUB_TOKEN` publish
  mechanism).

## Deliverable

Branch `feat/macos-support` on the contributor's fork → PR to `ah2k-dev/echolect`:
*"Add macOS support: build target, CI release workflow, and docs."* PR body explains the
unsigned-build tradeoff and lists code signing / notarization as a follow-up requiring the
maintainer's Apple Developer credentials.
