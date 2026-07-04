# Changelog

All notable changes to PageWise are documented here. Version numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.2] - 2026-07-04

### Added

- Lazy-loaded preview and chat panels; thumbnail sidebar windowing; pdf.js lazy loader with bundled cMaps
- Byte-budget PDF page cache; quality-aware cache lookup (fixes navBurst crisp miss); render-task cancellation
- Asset-protocol PDF byte loading with IPC fallback; `renderPageToJpegBytes` for vision indexing
- `findLastMessage` helper; unit tests for message search utilities

### Changed

- PDF text extraction unified on pdf.js (no blocking Rust extract on open; agent tools use frontend extract)
- Streaming throttle 50→100 ms; skip debounced chat save while streaming; memoized hot-path components
- Rust commands async via `spawn_blocking`; OCR stdin pipeline with PNG fallback; release profile LTO/strip
- Vite manual chunks, chrome110 target, drop console in production; `image` crate slimmed features

### Fixed

- Text layer always mounted with visibility toggle; resize observer debounced/quantized
- Preview render effect deps narrowed; stale render guard; thumbnails routed through render queue

## [0.2.1] - 2026-07-04

### Security

- Backend path allowlist: file commands (read / extract / OCR / write) reject any path not authorized via `register_allowed_path`; the frontend registers document and save paths
- Agent tools validate paths against loaded documents, blocking prompt-injection reads of arbitrary local files; document filename sanitized before entering the system prompt
- Enabled a real Content-Security-Policy (`script-src 'self'`) and narrowed the asset protocol scope from `**` to `$HOME/**`
- LLM-emitted Markdown links open via the opener plugin with a scheme allowlist instead of navigating the webview; remote images constrained
- Rewrote the secret scan (git-tracked files, match-first, hyphenated key formats); keychain provider names validated

### Fixed

- API keys: keychain JSON fallback is read back and preserved across saves (fixes silent key loss without a working keychain); custom provider with an empty base URL no longer sends the key to `api.openai.com`
- PDF viewer: render queue settles on cache clear (no hung viewer), pdf.js documents are destroyed, LRU page cache, corrected `devicePixelRatio` scaling
- Document load race, drag-drop listener leak, and StrictMode double-indexing fixed; vision indexing runs in a bounded pool with abort-on-switch, timeout, 429 backoff, and no re-billing of indexed pages
- Agent: `read_pdf_range` continues over-long pages via an offset; step and character budget added; dangling tool parts stripped on save/send to preserve tool pairing
- Chat-session store mutations serialized with corrupt-store guards; `page-intent` parses Chinese / full-width numerals and ranges; Unicode-safe search and slicing
- Accessibility: IME composition guard on Enter; keyboard-operable menus, tabs, command palette, and resize handle; focus-trap visibility fix; stacked-overlay Escape handling
- Light-theme contrast, consolidated tokens, z-index scale; confirmation before deleting library sessions; composer draft restored on send failure
- i18n plural / singular keys aligned between English and 简体中文

### Changed

- `package-lock.json` / `Cargo.lock` version kept in sync and covered by the CI drift check; release workflow fails on missing artifacts or tag/version mismatch; CI now compiles the Rust backend
- Documentation corrections (README / RELEASE / SECURITY); added `license` fields

## [0.2.0] - 2026-07-04

### Added

- Redesigned v3 UI: app rail, library drawer, welcome view, settings tabs
- macOS Keychain storage for API keys (`keyring` + Tauri commands)
- Per-provider LLM profiles (LlmStoreV2) with preview / set-active flow
- Chat session persistence per document with stable document switching
- Vision indexing for sparse PDF pages and images
- i18n: English and 简体中文
- Model capability hints (vision, tool calling) in settings
- OpenRouter tool-use validation and model migration
- Vitest unit tests for settings and chat sessions
- Pre-release secret scan (`npm run check:secrets`)
- Version sync script (`VERSION` → package.json / Tauri / Cargo)
- macOS DMG bundle configuration and GitHub release workflow

### Changed

- OpenRouter default model → `openai/gpt-4o-mini` (tool-capable)
- Settings auto-save with debounced persistence
- Improved agent error messages (Chinese + English)

### Security

- API keys no longer intended for plaintext storage in `settings.json`
- Redacted settings snapshots in debounced save comparisons
- Agent errors not logged to console in production builds

## [0.1.0] - 2026-07-03

Initial public release with PDF preview, OCR, streaming document agent, and multi-provider LLM support.

[Unreleased]: https://github.com/hxddh/pagewise/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/hxddh/pagewise/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/hxddh/pagewise/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hxddh/pagewise/releases/tag/v0.1.0
