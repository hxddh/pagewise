# Security

## API keys

PageWise stores LLM API keys in the **operating system credential store**, not in the git repository:

| Platform | Storage |
|----------|---------|
| macOS | Keychain (`pagewise` service, `api-key/{provider}` account) |
| Windows | Credential Manager |
| Linux | Secret Service (when available) |

Implementation: `src-tauri/src/secrets.rs`, `src/lib/api-key-store.ts`.

### Fallback behavior

If the keychain is unavailable, the app may temporarily persist the key in the local `settings.json` inside the Tauri app data directory. This file is **never** committed to git (see `.gitignore`). Users should prefer environments where keychain access works.

The mirror is not a dead end: it is offered to the keychain again whenever Settings is opened, and after any later successful keychain write, and it is removed from disk once the keychain has read the key back (20.0 — before that, nothing ever re-offered, so a key that landed on disk once stayed there). A keychain holding a *different* key is never written over.

### Local files

Every JSON store the app keeps is written atomically — a temp file, `fsync`, rename — and a file that cannot be read is left exactly as it is and reported, never read as empty and written over (20.0). Store files are addressed by a validated single-component name under the app data directory, by our own Rust commands; the webview has no general file access to them.

### What leaves your machine

- Extracted document text sent to your configured LLM endpoint
- Optional vision payloads when using multimodal indexing
- OpenRouter requests include `HTTP-Referer` and `X-Title` headers (no secrets)

### What stays local

- PDF/image files (read from paths you choose)
- Chat threads (`pagewise-v3-chats.json`, one thread per document path)
- Provider profiles without keys (`settings.json`, `preferences.json`)
- Recent files list and the paths you have authorized (`recent.json`, `allowed-paths.json`)
- The reader's marks (`marks.json`) and the record of findings (`findings.json`), with each kept answer's full text in `finding-bodies/<id>.json` beside it
- The vision page cache (`index-cache.json`) — text the reader paid for, kept so it is not paid for twice
- Recognised text for scanned documents (`ocr/`, one file per document fingerprint, pruned to 256 MB)

### Asset protocol

Preview thumbnails use Tauri’s `asset://` protocol. The default scope is **empty**; each opened document path is registered at runtime via `register_allowed_path`, which also adds that file to the asset allowlist. Arbitrary `$HOME` reads are not permitted by default.

## Pre-release checks

Before tagging a release, run:

```bash
npm run check:secrets   # scan tracked source for hardcoded credentials
npm test
npm run build
```

The CI workflow (`ci.yml`) runs the secret scan on pushes to `main` and on pull requests targeting `main`.

## Reporting vulnerabilities

If you discover a security issue, please open a private report via GitHub Security Advisories on [hxddh/pagewise](https://github.com/hxddh/pagewise/security/advisories/new) rather than filing a public issue.

## Developer hygiene

- Never commit `.env` files with real keys
- Use placeholder values in tests only (e.g. `sk-test`)
- Avoid logging `LlmSettings` objects containing `apiKey` — this is a code-review
  guideline, not an automatically enforced guarantee, so review diffs accordingly
