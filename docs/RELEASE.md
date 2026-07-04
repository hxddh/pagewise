# Release guide

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
- [ ] Agent works with a tool-capable model
- [ ] Keychain read/write in Settings → AI Provider

## macOS artifacts

After `npm run tauri build` on `macos-latest` (Apple Silicon runner):

```
src-tauri/target/release/bundle/macos/PageWise.app
src-tauri/target/release/bundle/dmg/PageWise_0.2.0_aarch64.dmg   # Apple Silicon (arm64)
```

> The CI workflow runs a plain `npm run tauri build` on `macos-latest`, which
> produces the **arm64 DMG only**. An Intel `x64.dmg` is **not currently
> produced** — it would require an explicit `--target x86_64-apple-darwin`
> cross-build step that the workflow does not yet include.

## GitHub release

1. Commit and push to `main`
2. Tag:

   ```bash
   git tag -a v0.2.0 -m "PageWise 0.2.0"
   git push origin v0.2.0
   ```

3. GitHub Actions (`release.yml`) builds the macOS DMG and attaches it to the release, **or** upload the local DMG manually via the Releases UI.

### Code signing (not yet wired)

> **Note:** `release.yml` does **not** currently sign or notarize builds. The
> steps below describe what *would* need to be added; none of these secrets or
> hooks exist in the workflow today.

CI-built DMGs are unsigned, so users must right-click → **Open** (or run
`xattr -dr com.apple.quarantine /Applications/PageWise.app`) on first launch.
For signed distribution outside your team you would need to:

- Obtain an Apple Developer ID Application certificate
- Add `APPLE_SIGNING_IDENTITY` (and related secrets) to the release workflow
- Notarize with `notarytool`

See [Tauri macOS code signing](https://v2.tauri.app/distribute/sign/macos/).

## CI

- **ci.yml** — secret scan, unit tests, frontend typecheck/build, version-sync
  drift check, and `cargo check` (Rust) on pushes to `main` and PRs targeting `main`
- **release.yml** — triggered on `v*` tags. Verifies the tag matches `VERSION`,
  builds the arm64 macOS bundle, fails if no `.dmg` is produced, and attaches the
  `.dmg` (plus a `PageWise.app.tar.gz` of the `.app`) to the GitHub Release
