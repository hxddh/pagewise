# PageWise

Local desktop document agent for **PDF text extraction**, **vision indexing**, and **page-wise AI analysis**.

Built with **Tauri 2**, **React 19**, and the [Vercel AI SDK](https://ai-sdk.dev). Documents are processed on your machine; only extracted text (and optional vision payloads) are sent to the LLM you configure.

## Features

- **Documents** — Open PDFs and images via file picker or drag & drop
- **Preview** — Page navigation, thumbnails, zoom, in-document search (⌘F)
- **Indexing** — PDF text layer plus optional vision model indexing for scans and images
- **Agent** — Streaming chat with tool calls (`document_outline`, `read_pdf_page`, `search_in_document`, …)
- **Marks** — Highlight a passage, add a note; kept per document, visible to the agent, and included in the Markdown export
- **Record** — What the assistant establishes and what you keep from its answers, each with the pages it came from, the wording it rests on, and one trust state (*checked*, *found on the page*, *re-check*) that the panel, the model and the export all read
- **Brief** — Export the record as one Markdown file: conclusions, evidence, and what still needs re-checking
- **Chat** — One thread per document, persisted locally; a renamed or moved file finds its own chat, marks and record by content fingerprint
- **Library** — Recent files, each reopening at the page you left and saying how much of the record is waiting on you
- **Providers** — OpenAI, DeepSeek, OpenRouter, Ollama, or any OpenAI-compatible endpoint
- **Security** — API keys stored in the **OS keychain** (macOS Keychain / Windows Credential Manager / Linux Secret Service)
- **i18n** — English and 简体中文

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| [Node.js](https://nodejs.org/) 22+ | For frontend build |
| [Rust](https://www.rust-lang.org/tools/install) | Tauri backend |

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
| `npm run tauri build` | Desktop installers for the current platform |
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
React UI  →  PagewiseChatTransport + ToolLoopAgent (AI SDK)
          →  Tauri invoke  →  Rust (pdf-inspector, file I/O, keychain)
          →  OS Keychain   →  API keys (per provider)
```

## Install

Every release on [GitHub Releases](https://github.com/hxddh/pagewise/releases) carries installers for three platforms:

| Platform | Asset |
|---|---|
| macOS (Apple Silicon) | `PageWise_<version>_aarch64.dmg` — open it and drag PageWise to Applications |
| Windows (x86-64) | `PageWise_<version>_x64-setup.exe` or `PageWise_<version>_x64_en-US.msi` |
| Linux (x86-64) | `pagewise_<version>_amd64.AppImage` (`chmod +x` and run) or `.deb` |

**Nothing is code-signed or notarized.** On macOS, Gatekeeper blocks the first launch — either right-click the app and choose **Open** (then confirm), or clear the quarantine attribute:

```bash
xattr -dr com.apple.quarantine /Applications/PageWise.app
```

Windows SmartScreen shows a "unrecognized app" warning for the same reason; choose **More info → Run anyway**.

To build locally:

```bash
npm run tauri build
# Artifacts: src-tauri/target/release/bundle/
```

See [docs/RELEASE.md](docs/RELEASE.md) for the full release checklist.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
