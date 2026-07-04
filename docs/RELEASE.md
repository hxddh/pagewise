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

After `npm run tauri build`:

```
src-tauri/target/release/bundle/macos/PageWise.app
src-tauri/target/release/bundle/dmg/PageWise_0.2.0_aarch64.dmg   # Apple Silicon
src-tauri/target/release/bundle/dmg/PageWise_0.2.0_x64.dmg       # Intel (cross-build)
```

## GitHub release

1. Commit and push to `main`
2. Tag:

   ```bash
   git tag -a v0.2.0 -m "PageWise 0.2.0"
   git push origin v0.2.0
   ```

3. GitHub Actions (`release.yml`) builds the macOS DMG and attaches it to the release, **or** upload the local DMG manually via the Releases UI.

### Code signing (optional)

Unsigned builds run on macOS after right-click → Open. For distribution outside your team:

- Apple Developer ID Application certificate
- Set `APPLE_SIGNING_IDENTITY` in the release workflow
- Notarize with `notarytool`

See [Tauri macOS code signing](https://v2.tauri.app/distribute/sign/macos/).

## CI

- **ci.yml** — tests + secret scan on push/PR
- **release.yml** — triggered on `v*` tags, produces macOS DMG artifact
