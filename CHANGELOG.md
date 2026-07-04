# Changelog

All notable changes to PageWise are documented here. Version numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

### Changed

### Fixed

### Security

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

[Unreleased]: https://github.com/hxddh/pagewise/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/hxddh/pagewise/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hxddh/pagewise/releases/tag/v0.1.0
