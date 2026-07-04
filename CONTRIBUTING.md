# Contributing to PageWise

Thanks for your interest in PageWise!

## Development setup

```bash
git clone https://github.com/hxddh/pagewise.git
cd pagewise
npm install
brew install tesseract tesseract-lang   # macOS OCR
npm run tauri dev
```

## Project layout

```
src/                 React frontend
src-tauri/           Rust backend (Tauri)
src/i18n/            Translations (en, zh-CN)
scripts/             Version sync, secret scan
docs/                Security, release guides
```

## Before submitting changes

```bash
npm test
npm run check:secrets
npm run build
```

## Pull requests

1. Fork and create a feature branch from `main`
2. Keep changes focused; match existing code style
3. Update `CHANGELOG.md` under **Unreleased** for user-visible changes
4. Do not commit API keys, `.env` files, or local `settings.json`

## Versioning

Edit `VERSION` and run `npm run version:sync`. Release maintainers tag `v*` after merging to `main`.

## Questions

Open a [GitHub Discussion](https://github.com/hxddh/pagewise/discussions) or issue for bugs and feature requests.
