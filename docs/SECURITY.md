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

### What leaves your machine

- Extracted document text sent to your configured LLM endpoint
- Optional vision payloads when using multimodal indexing
- OpenRouter requests include `HTTP-Referer` and `X-Title` headers (no secrets)

### What stays local

- PDF/image files (read from paths you choose)
- Chat sessions (`sessions.json`)
- Provider profiles without keys (`settings.json`)
- Recent files list

## Pre-release checks

Before tagging a release, run:

```bash
npm run check:secrets   # scan tracked source for hardcoded credentials
npm test
npm run build
```

The CI workflow runs the secret scan on every push and pull request.

## Reporting vulnerabilities

If you discover a security issue, please open a private report via GitHub Security Advisories on [hxddh/pagewise](https://github.com/hxddh/pagewise/security/advisories/new) rather than filing a public issue.

## Developer hygiene

- Never commit `.env` files with real keys
- Use placeholder values in tests only (e.g. `sk-test`)
- Do not log `LlmSettings` objects containing `apiKey`
