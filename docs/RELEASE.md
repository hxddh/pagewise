# Release guide

## When to release (v23)

From 17.0 to 21.1 a release went out with almost every merge — eleven on
14–15 October alone — to a product with no updater and, on macOS, one
`xattr` step per installed version. Anyone who installed was behind within
the day. So:

- **A fix that loses or corrupts the reader's data ships as a patch at once**
  (21.0.1 is the example).
- **Everything else collects on `main` and ships at most once a week**, as one
  minor release, with one changelog section.
- **The major number is for a change that breaks something a reader has**:
  a store format an older build cannot read, a removed feature, a changed
  file on disk. Not for "the next round of work". (v22 shipped as 21.1.x for
  that reason; see the note at the top of `CHANGELOG.md`.)

## Version bump

1. Edit [`VERSION`](../VERSION) (canonical semver, e.g. `0.2.1`)
2. Sync all manifests:

   ```bash
   npm run version:sync
   ```

3. Update [`CHANGELOG.md`](../CHANGELOG.md)

## Pre-release checklist

```bash
npm run check:secrets
npm test
npm run build
npm run tauri build
```

Verify:

- [ ] No API keys in git history or working tree
- [ ] About screen shows correct version
- [ ] macOS `.dmg` opens and app launches
- [ ] Windows installer runs and the app starts (keys land in Credential Manager)
- [ ] Linux `.AppImage` runs (keys land in Secret Service — needs a running keyring daemon)
- [ ] Agent works with a tool-capable model
- [ ] Keychain read/write in Settings → Assistant → Advanced

## Artifacts

`release.yml` builds on three runners in parallel and attaches everything to one
release:

| Runner | `--bundles` | Produces |
|---|---|---|
| `macos-latest` (universal) | `dmg,app` with `--target universal-apple-darwin` | `PageWise_<v>_universal.dmg`, `PageWise.app.tar.gz` |
| `windows-latest` | `msi,nsis` | `PageWise_<v>_x64_en-US.msi`, `PageWise_<v>_x64-setup.exe` |
| `ubuntu-22.04` | `deb,appimage` | `pagewise_<v>_amd64.deb`, `pagewise_<v>_amd64.AppImage` |

macOS is built **universal** (aarch64 + x86_64 in one binary) rather than per-architecture. An arm64-only download on an Intel Mac fails with the same wording as a damaged bundle — "the application cannot be opened" — so one artifact for both removes a whole class of install reports, at the cost of a longer macOS build. The job adds the Intel target (`rustup target add x86_64-apple-darwin`) and its bundles land under `src-tauri/target/universal-apple-darwin/release/bundle`, which `verify-bundle-version.mjs` and the workflow's collect step both know about.

Ubuntu 22.04 rather than `ubuntu-latest` on purpose: a binary's glibc floor is the image it was built on, so building on the oldest supported image is what lets it run on anything older.

**Still not produced:** any ARM Linux or ARM Windows build.

`fail-fast` is off and the release job runs even when a platform fails, so one broken runner degrades the release to the platforms that did build rather than cancelling it. A release with every platform failed is refused.

## GitHub release

1. Commit and push to `main`
2. Tag:

   ```bash
   git tag -a v0.2.0 -m "PageWise 0.2.0"
   git push origin v0.2.0
   ```

3. GitHub Actions (`release.yml`) builds all three platforms and attaches them to the release, **or** upload local installers manually via the Releases UI.

### Code signing

The macOS bundle is **ad-hoc signed** — `bundle.macOS.signingIdentity: "-"` in `tauri.conf.json`. This is deliberate and is the supported option for a project without an Apple Developer certificate ([Tauri: Ad-Hoc Signing](https://v2.tauri.app/distribute/sign/macos/)).

Why it is not optional: on Apple Silicon, macOS requires every executable to carry a signature, and a **downloaded** `.app` that has none is not reported as an unverified developer — it is reported as *"PageWise is damaged and can't be opened. You should move it to the Trash."* 17.0.0 shipped that way and produced exactly that message: the published `.app` had no `Contents/_CodeSignature` at all. Ad-hoc signing gives the bundle a real signature, so the failure mode is the ordinary unverified-developer prompt, which has a way through (right-click → **Open** before macOS 15; **System Settings → Privacy & Security → Open Anyway** from macOS 15 on).

What it does **not** do is remove the prompt. Only notarization does, and notarization needs:

- an Apple Developer account with a `Developer ID Application` certificate
- `APPLE_CERTIFICATE` (base64 `.p12`) + `APPLE_CERTIFICATE_PASSWORD` secrets, imported into a temporary keychain in the macOS job
- `APPLE_ID` + `APPLE_PASSWORD` (app-specific) + `APPLE_TEAM_ID` for `notarytool`, which Tauri drives when these are present
- `APPLE_SIGNING_IDENTITY` set to the certificate's name instead of `-`

With those in place, `tauri build` signs and notarizes in one pass and the download opens with no prompt at all. Until then, the README's install section is the user-facing instruction, and it is the place to keep current: the "damaged" wording, the one-line `xattr -dr com.apple.quarantine` fix, and the macOS 15 change to the manual bypass are all recorded there.

## Window material (18.0)

The main window is `transparent: true` with `macOSPrivateApi: true`, and the app asks for a material at runtime (`setEffects`: macOS vibrancy, Windows Mica) plus a theme-matched `setBackgroundColor`. Two consequences for a release:

- The capabilities file must keep `core:window:allow-set-effects` and `core:window:allow-set-background-color`. Neither is in `core:window:default`.
- Linux has no equivalent. The app is written so that the unsupported case is the plain opaque app: `data-material` is only set when the effect took, and the translucent surfaces are gated on it. A Linux screenshot showing a solid sidebar is correct, not a bug.

## CI

- **ci.yml** — secret scan, unit tests, frontend typecheck/build, version-sync
  drift check, and `cargo check` (Rust) on pushes to `main` and PRs targeting `main`
- **release.yml** — triggered on `v*` tags or dispatched manually. Three jobs:
  `prepare` (tag/VERSION match, CHANGELOG section, secret scan, tests — all the
  failures that should not cost a build), `build` (the three-platform matrix),
  and `release` (collects every artifact and publishes one release whose body is
  that version's CHANGELOG section followed by the generated commit list)
