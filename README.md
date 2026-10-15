# PageWise

Local desktop document agent for **PDF text extraction**, **local OCR of scanned pages**, and **page-wise AI analysis**.

Built with **Tauri 2**, **React 19**, and the [Vercel AI SDK](https://ai-sdk.dev). Documents are processed on your machine; only extracted text (and optional vision payloads) are sent to the LLM you configure.

## Features

- **Documents** — Open PDFs and images via file picker or drag & drop
- **Preview** — Page navigation, thumbnails, zoom (⌘+ / ⌘− / ⌘0), in-document search (⌘F), and `j`/`k` to scroll a screenful at a time
- **Indexing** — PDF text layer; scanned pages are read on your machine (English and Simplified Chinese), with a vision model as an optional fallback for pages that do not read well
- **Agent** — Streaming chat with tool calls (`document_outline`, `read_pdf_page`, `search_in_document`, …)
- **Checked citations** — Every fact in an answer cites its page and the words it rests on; PageWise looks the words up on that page and shows whether they are there. Click a citation to see the passage lit on the page — on scanned pages too. A found quote under a sentence whose number the passage does not state is flagged, and your model can be asked, on demand, whether each passage supports its sentence
- **Marks** — Highlight a passage, add a note; kept per document, visible to the agent, and included in the Markdown export
- **Record** — What the assistant establishes and what you keep from its answers, each with the pages it came from, the wording it rests on, and one of three levels (*verified*, *check the page*, *not found*) that the panel, the model and the export all read
- **Reading** — The answer column is a reading column: resizable, headings that step, ruled tables, and the tool steps below the answer where provenance belongs. A **paper** theme (warm page, warm chrome), a reading text scale, and **Zen** (⌘⇧F): the rail, the toolbar and the panel leave, and the page, a progress hairline and one "Ask" pill stay
- **Export** — One dialog, three things: **Report** (the record and your marks, with the document's text on request), **PDF with evidence**, and **Conversation**
- **Evidence in the PDF** — Export a copy of the document with located findings and your marks written in as standard highlights and notes, readable in any PDF reader
- **Cited tables** — Ask for a list or comparison and get a table with a checked citation in every cell; export it as CSV with each row's sources and whether they were found
- **Chat** — One thread per document, persisted locally; a renamed or moved file finds its own chat, marks and record by content fingerprint
- **Library** — Recent files, each reopening at the page you left and saying how much of the record is waiting on you
- **Providers** — OpenAI, DeepSeek, OpenRouter, Ollama, or any OpenAI-compatible endpoint. First run is one page: a provider, a key, and **Start reading** — the model is chosen from the provider's own presets and everything expert stays behind Advanced
- **Cost, visible** — One line under every answer: pages read, steps, tokens in and out, cache hits, scan calls (turn it off in Settings → Assistant). The system prompt and tool definitions are budgeted by a test, and the read budget is charged in tokens, not characters, so a Chinese document costs what an English one does
- **Material** — On macOS and Windows the window sits on real material (vibrancy, Mica) with a theme-matched background; where there is no equivalent, every surface stays opaque
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

First run is one page: pick a provider, paste an API key (stored in the OS keychain), click **Start reading**. The model is chosen automatically from the provider's presets; the file picker opens next.

Afterwards everything lives in one Settings surface, in three groups:

- **Appearance & language** — dark, light, **paper**, or follow the system
- **Reading** — text size, local OCR for scanned pages, how many pages may be read in the cloud, and the text cache
- **Assistant** — the model (Automatic by default), the current-page screenshot toggle, the cost line — and **Advanced** for the provider, the key, the endpoint, the scan model, extended thinking and the connection test

**OpenRouter:** Use a **tool-capable** model (e.g. `openai/gpt-4o-mini`) for the document agent. Some DeepSeek routes on OpenRouter do not support tool calling.

**Scans:** Scanned pages are read on your machine with no key and no cost. A multimodal model (e.g. `gpt-4o-mini`, Qwen2.5-VL) is optional, for pages local recognition cannot read or reads poorly, and other languages — 20 pages of a document in the background, 10 per question, both adjustable.

See [docs/SECURITY.md](docs/SECURITY.md) for how credentials are handled.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server only |
| `npm run perf` | The performance probe: four scenarios, twenty-two budgets (build first) |
| `npm run tauri dev` | Desktop app (recommended) |
| `npm run build` | Frontend production build |
| `npm run tauri build` | Desktop installers for the current platform |
| `npm test` | Unit tests (Vitest) |
| `npm run check:secrets` | Pre-release credential scan |
| `npm run version:sync` | Sync `VERSION` → package / Tauri / Cargo |
| `npm run eval` | Measure citation location (text layers and scanned pages) and search on the evaluation corpus (see [eval/README.md](eval/README.md)) — needs `npm run eval:fetch` once for the pinned third-party documents |
| `npm run ui:inventory` | With `npm run dev` running: count what a reader is shown — buttons under an answer, export entries, settings rows, citation levels, and the reading surface's width, heading step, table rules and action contrast |
| `npm run ui:shots` | With `npm run dev` running: photograph the 13 screens a reader sees into `docs/ui-shots/` |
| `npm run audit:claims` | With `npm run dev` running: follow a citation whose number does not hold through its chip, the model review and the next question |
| `npm run audit:tables` | With `npm run dev` running: follow a cited table answer through its chips, the CSV export and the record |
| `npm run audit:ocr` | After `npm run build`: open a scanned document in Chromium under the app's CSP and follow one cited answer end to end |

## Versioning

The canonical version lives in [`VERSION`](VERSION). Run `npm run version:sync` after editing it, or pass an explicit version:

```bash
node scripts/sync-version.mjs 0.2.1
```

Release notes are recorded in [CHANGELOG.md](CHANGELOG.md).

## Architecture

```
React UI  →  PagewiseChatTransport + ToolLoopAgent (AI SDK)
          →  Web Worker    →  tesseract.js (local OCR of scanned pages)
          →  Tauri invoke  →  Rust (pdf-inspector, file I/O, OCR cache, keychain)
          →  OS Keychain   →  API keys (per provider)
```

## Install

Every release on [GitHub Releases](https://github.com/hxddh/pagewise/releases) carries installers for three platforms:

| Platform | Asset |
|---|---|
| macOS (Apple Silicon **and** Intel) | `PageWise_<version>_universal.dmg` — open it and drag PageWise to Applications |
| Windows (x86-64) | `PageWise_<version>_x64-setup.exe` or `PageWise_<version>_x64_en-US.msi` |
| Linux (x86-64) | `pagewise_<version>_amd64.AppImage` (`chmod +x` and run) or `.deb` |

**Nothing is notarized.** The macOS bundle is *ad-hoc signed* (`signingIdentity: "-"`). That matters because an unsigned `.app` downloaded to an Apple Silicon Mac is refused as **“PageWise is damaged and can’t be opened. You should move it to the Trash.”** — no right-clicking clears that. With the signature, the refusal is the ordinary “cannot be opened” of an app macOS cannot verify.

Either way the way through is one command, run once per installed version:

```bash
xattr -dr com.apple.quarantine /Applications/PageWise.app
```

Then open the app normally. Nothing is wrong with the file — the quarantine attribute is what macOS adds to *any* download, and it is what makes an unnotarized app fail its check. To confirm the download itself is intact first, `codesign --verify --deep --strict /Applications/PageWise.app` should print nothing.

Without the terminal: attempt to open the app once, then **System Settings → Privacy & Security**, scroll to **Security**, and click **Open Anyway** next to the blocked app. macOS 15 removed the old right-click → **Open** shortcut, and this is its replacement. If no such entry appears, the command above is the reliable path.

Repeat the step after installing a new version: ad-hoc signatures differ per build, so macOS treats each one as an app it has not been told about. **Notarization is what removes the step entirely** — see the release guide for what it needs.

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
