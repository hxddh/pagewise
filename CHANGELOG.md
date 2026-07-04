# Changelog

All notable changes to PageWise are documented here. Version numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.11] - 2026-07-04

### Added

- Assistant message footer: copy, regenerate, and usage stats popover (input/output tokens, TTFT, speed, index vs chat split)
- Agent: `smoothStream` word chunking, structured citations via `generateObject`, and live tool-progress data parts
- Search: hybrid keyword + semantic retrieval with embedding index and lexical `rerank` pass
- Agent loop: `runtimeContext` default doc path, `prepareStep` fast-model routing, and `pruneMessages` for long contexts
- Export summary: `streamObject` structured Markdown export with streaming generation
- Debug: per-step token usage in stats popover (`onStepEnd` metadata)
- Tests: `ai/test` mocks for transport metadata, rerank, and export summary

### Changed

- Thinking/reasoning: top-level AI SDK `reasoning` parameter replaces custom fetch body injection (OpenRouter headers only)

## [0.2.10] - 2026-07-04

### Fixed

- Agent: prevent overlapping sends during settings load; rollback view context on send failure; restore composer draft on errors
- Settings: vision model restores correctly when switching providers; vision-only edits persist via debounced save
- Settings: explicitly cleared API keys are not re-imported from Keychain on migration retry
- PDF preview: cancelled renders are no longer cached as valid frames
- Indexing: clear stale index state on document reopen/reindex; require MIN_INDEX_CHARS before marking done; honor abort before OCR
- Path restore: prune missing paths from recents (no repeated startup toasts); register `/` parent for root-level files
- Security: `write_text_file` canonicalizes target path and rejects symlink escapes
- Streaming markdown: fence-aware paragraph split; tail renders markdown during live stream
- MessageContent: stronger parts signature and live prop memo; unique tool detail keys
- Follow agent: sync to the latest read tool page; re-scan when re-enabled
- docCache: evict oldest documents when cache exceeds 12 entries

## [0.2.9] - 2026-07-04

### Fixed

- Dock / bundle icon: brand dark background with accent stacked pages (matches in-app LogoMark colors)
- Logo geometry and palette centralized in `logo-mark-assets.json`; `app-icon.svg` generated from it
- Saved file paths that fail to restore on launch are pruned and surfaced via toast
- Streaming assistant replies: completed paragraphs are parsed once; only the tail re-renders during stream
- `verify-bundle-version` uses filesystem lookup instead of shell glob

### Changed

- `beforeBuildCommand` runs `icons:generate` so bundle icons stay in sync with logo assets
- `icons:generate` now regenerates `app-icon.svg` before rasterizing platform icons

## [0.2.8] - 2026-07-04

### Fixed

- About screen version now reads the macOS bundle version at runtime (matches Finder / Get Info)
- Release builds verify `Info.plist` `CFBundleShortVersionString` matches `VERSION`

### Changed

- Dock / app bundle icons regenerated to match in-app LogoMark (stacked pages + green dot, no black background)
- Tauri `version` reads from `package.json`; `beforeBuildCommand` runs `version:sync` before each build
- Added `npm run icons:generate` and `npm run verify:bundle-version` scripts

## [0.2.7] - 2026-07-04

### Fixed

- Agent tool steps: aggregate searches/tools across `reasoning` and `step-start` boundaries while preserving intro text before the tool block
- Agent streaming: yield to WebKit between tool steps; live message re-renders on part updates without full memo bypass
- API key migration: only mark Keychain migration complete when reads succeed; retry on next launch if access was denied
- Provider switch / autosave: stop rewriting Keychain when the API key did not change
- File access after restart: persist allowed paths (and parent directories) across launches; restore on startup with recent files
- Opening a document fails fast when path registration fails instead of a late opaque error
- Chat progress bar no longer overlaps when the assistant is streaming `reasoning` before text

### Changed

- File picker uses scoped access mode on macOS for better document permission handling

## [0.2.6] - 2026-07-04

### Fixed

- Agent chat stuck on「已调用工具」with no output until the end: group tool steps across agent `step-start` boundaries; show live in-progress labels and a persistent progress bar
- Agent send no longer hangs silently when API key is missing; validate key before dispatch
- API key re-entry after reinstall or provider switch: always mirror keys to local settings; read local copy first to avoid repeated macOS Keychain prompts
- Trackpad page turns on tall pages: scroll within the page before flipping at top/bottom edge

### Changed

- Tool progress during streaming: aggregate completed steps and show current action (e.g.「已搜索 2 次 · 正在搜索文档…」)
- Final answer text streams incrementally once generation starts
- `connectionVerified` no longer treated as having a stored API key when the key is actually missing

## [0.2.5] - 2026-07-04

### Fixed

- Agent chat: tool-only replies no longer show only「已调用工具」— defer history prune until stream flush; surface reasoning when no text answer
- Trackpad PDF page turns: flip on threshold instead of waiting for gesture end; faster cooldowns and instant performance rendering during swipe

### Changed

- Agent tool steps aggregated into a collapsible summary (e.g.「已搜索 6 次 · 已调用工具 1 次」) instead of stacking many chips
- Touchpad flips skip page-turn animation; keyboard navigation keeps it
- PDF preview checks page cache before async fit-width scale resolution

## [0.2.4] - 2026-07-04

### Fixed

- PDF open/preview crash in Tauri WebView (`undefined is not a function`): restore Rust text extraction on open; pdf.js used for canvas render only
- pdf.js cMap / standard font assets copied at build time; runtime URLs resolved against webview origin
- `read_file_bytes` returns `Vec<u8>` for reliable IPC byte loading
- Chat messages without `parts` normalized on load; guards against iterator errors in agent sync and rendering
- `Promise.withResolvers` polyfill for pdf.js on older WebKit builds

### Changed

- Agent page reads use Rust `extract_pdf_text_cmd` instead of pdf.js text layer
- Text selection layer disabled in Tauri desktop (preview canvas only)
- Preview error banner shows the underlying message for easier diagnosis

## [0.2.3] - 2026-07-04

### Fixed

- PDF index badge false failures: wait for pdf.js text extraction, sync docCache to UI, recover from stale failed state
- Agent 404 misreported as “model/endpoint not found” when OpenRouter lacks tool-use routes; correct error ordering
- OpenRouter VL models no longer used as agent model; auto-migrate to split agent + vision models
- Startup keychain password prompt: defer API key read until settings/agent need it
- Logo: Dock / app bundle icons regenerated to match in-app document mark (stacked pages + green dot)

### Changed

- Settings: separate **Agent model** and **Indexing model (vision)**; test connection probes tool calling
- Vision indexing uses dedicated vision model settings

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

[Unreleased]: https://github.com/hxddh/pagewise/compare/v0.2.11...HEAD
[0.2.11]: https://github.com/hxddh/pagewise/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/hxddh/pagewise/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/hxddh/pagewise/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/hxddh/pagewise/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/hxddh/pagewise/compare/v0.2.6...v0.2.7
[0.2.1]: https://github.com/hxddh/pagewise/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/hxddh/pagewise/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hxddh/pagewise/releases/tag/v0.1.0
