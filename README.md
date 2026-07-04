# PageWise

Local desktop document agent for **PDF text extraction**, **OCR**, **vision indexing**, and **page-wise AI analysis**.

Built with **Tauri 2**, **React 19**, and the [Vercel AI SDK](https://ai-sdk.dev). Documents are processed on your machine; only extracted text (and optional vision payloads) are sent to the LLM you configure.

## Features

- **Documents** — Open PDFs and images via file picker or drag & drop
- **Preview** — Page navigation, thumbnails, zoom, in-document search (⌘F)
- **Indexing** — PDF text layer, Tesseract OCR, optional vision model indexing for scans
- **Agent** — Streaming chat with tool calls (`read_pdf_page`, `search_in_document`, …)
- **Sessions** — Per-document chat threads persisted locally
- **Library** — Recent files and saved sessions
- **Providers** — OpenAI, DeepSeek, OpenRouter, Ollama, or any OpenAI-compatible endpoint
- **Security** — API keys stored in the **OS keychain** (macOS Keychain / Windows Credential Manager / Linux Secret Service)
- **i18n** — English and 简体中文

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| [Node.js](https://nodejs.org/) 22+ | For frontend build |
| [Rust](https://www.rust-lang.org/tools/install) | Tauri backend |
| **Tesseract** | OCR for images and scanned PDFs |

```bash
brew install tesseract tesseract-lang
```

## Quick start

```bash
git clone https://github.com/hxddh/pagewise.git
cd pagewise
npm install
npm run tauri dev
```

## Configuration

1. Open **Settings → AI Provider**
2. Choose a provider and model
3. Enter your API key (stored in the OS keychain)
4. Click **Set active** — settings auto-save

**OpenRouter:** Use a **tool-capable** model (e.g. `openai/gpt-4o-mini`) for the document agent. Some DeepSeek routes on OpenRouter do not support tool calling.

**Vision / scans:** Pick a multimodal model (e.g. `gpt-4o-mini`, Qwen2.5-VL) for image-heavy documents.

See [docs/SECURITY.md](docs/SECURITY.md) for how credentials are handled.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server only |
| `npm run tauri dev` | Desktop app (recommended) |
| `npm run build` | Frontend production build |
| `npm run tauri build` | macOS `.app` + `.dmg` |
| `npm test` | Unit tests (Vitest) |
| `npm run check:secrets` | Pre-release credential scan |
| `npm run version:sync` | Sync `VERSION` → package / Tauri / Cargo |

## Versioning

The canonical version lives in [`VERSION`](VERSION). Run `npm run version:sync` after editing it, or pass an explicit version:

```bash
node scripts/sync-version.mjs 0.2.1
```

Release notes are recorded in [CHANGELOG.md](CHANGELOG.md).

## Architecture

```
React UI  →  AI SDK (DirectChatTransport + ToolLoopAgent)
          →  Tauri invoke  →  Rust (pdf-extract, Tesseract)
          →  OS Keychain   →  API keys (per provider)
```

## macOS install

Download the latest **`.dmg`** from [GitHub Releases](https://github.com/hxddh/pagewise/releases), open it, and drag PageWise to Applications.

**Install Tesseract** — OCR is a hard prerequisite even for the prebuilt app; without it, image and scanned-PDF indexing will not work:

```bash
brew install tesseract tesseract-lang
```

**Unsigned builds** — CI-built DMGs are **not code-signed or notarized**, so Gatekeeper will block the first launch. Either right-click the app and choose **Open** (then confirm), or clear the quarantine attribute:

```bash
xattr -dr com.apple.quarantine /Applications/PageWise.app
```

To build locally:

```bash
npm run tauri build
# Artifacts: src-tauri/target/release/bundle/dmg/*.dmg
```

See [docs/RELEASE.md](docs/RELEASE.md) for the full release checklist.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
