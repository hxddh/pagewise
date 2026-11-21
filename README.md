# PageWise

A local-first desktop PDF reader where **every AI answer cites the exact page and verbatim passage it rests on — and verifies both on your machine**.

Built with **Tauri 2**, **React 19**, and the [Vercel AI SDK](https://ai-sdk.dev). Reading, instant full-text search (`⌘F`), highlights, margin notes, and scanned-page OCR work offline out of the box with no account and no API key. When you connect an LLM, only the pages the assistant reads are sent to the provider you choose.

## Download

Installers for every release are published on [GitHub Releases](https://github.com/hxddh/pagewise/releases):

| Platform | Asset |
|---|---|
| macOS (Apple Silicon & Intel) | `PageWise_<version>_universal.dmg` |
| Windows (x86-64) | `PageWise_<version>_x64-setup.exe` or `PageWise_<version>_x64_en-US.msi` |
| Linux (x86-64) | `pagewise_<version>_amd64.AppImage` or `.deb` |

## Highlights

- **First a reader, instant on open** — Smooth virtualized scrolling, **Comfortable Fit**, **Fit Page** (`⌘9`), cursor-anchored trackpad pinch-to-zoom, reader **Back / Forward** history (`Alt+←` / `Alt+→`), printed page labels (`iv`, `A-3`), internal GoTo links, top-right non-blocking search (`⌘F`, `Enter` / `⇧Enter` / `⌘G`) with BM25 related-page fallback, session-only in-memory password unlock for encrypted PDFs, and **Dark**, **Light**, **Paper**, and **Night** reading modes.
- **Scanned pages you can select, search, and cite** — Local OCR (English and Simplified Chinese, auto-detected per document) populates a geometry-calibrated text layer over rotated and cropped scanned pages so you can drag-select text, highlight passages across page breaks, search, and verify citations without spending a cloud call.
- **The Living Margin** — Close the assistant column (or enter **Zen**, `⌘⇧F`) and keep asking from the compact floating bar: live tool progress, mid-run steering, uncited summary cards, and cited passages stream directly into the page's outer margin with colour-coded verification ties.
- **Entailment 2.0: checked citations, numbers, dates & polarity** — Every factual sentence cites its page and verbatim wording (`〔p12 "…"〕`). PageWise locates those words on the page — handling Markdown formatting, ligatures, hyphenated line breaks, multi-column tables, and `…` elisions — and flags sentences that state unstated quantities, mismatched units (`ms` vs `s`, `bps` vs `%`), wrong calendar dates (`April 17, 2025` vs `2025-04-18`), or flipped polarity/bounds (`shall not` ↔ `may`, `at least` ↔ `no more than`, `甲方` ↔ `乙方`).
- **Marks, Regions & the Record** — Highlight text or drag a region box (`[Ask about this] [Mark]`), attach notes right in the margin, and keep verified conclusions in the **Record** ledger — persisted locally and carried across file renames/moves by content fingerprint.
- **Three clean exports** — **Report (`.md`)** with findings, trust status, and marks; **PDF with evidence** writing highlights and pop-up notes directly into a standard PDF copy; and **Conversation (`.md`)** (plus **CSV with sources** under any cited table).
- **Providers & privacy** — First-run setup is a 2×2 grid (**OpenAI**, **DeepSeek**, **OpenRouter**, **Ollama (local)**) plus custom OpenAI-compatible endpoints, verified before saving. API keys live in the **OS Keychain** (macOS Keychain / Windows Credential Manager / Linux Secret Service). Zero telemetry; update checks in **Settings → About** run only when clicked.

## Prerequisites (building from source)

| Requirement | Notes |
|-------------|-------|
| [Node.js](https://nodejs.org/) 22+ | Frontend & tooling |
| [Rust](https://www.rust-lang.org/tools/install) | Tauri backend |

## Quick start

```bash
git clone https://github.com/hxddh/pagewise.git
cd pagewise
npm install
npm run tauri dev
```

## Configuration

Everything lives in one Settings drawer across three groups:

- **Appearance & language** — Dark, Light, **Paper** (warm sepia page & chrome), **Night** (smart dark-page mode), or System; English and 简体中文.
- **Reading** — Reading text scale, local OCR for scanned pages, cloud scan budget (`Off` / `Auto` / `All`), follow-assistant page turning, and the extracted-text cache.
- **Assistant** — Model preset (`Automatic` by default) and current-page screenshot toggle; **Advanced** holds provider switching, API keys, custom endpoints, scan model, extended thinking, per-answer token/cost line (off by default), and connection testing.

See [docs/SECURITY.md](docs/SECURITY.md) for credential storage details.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server |
| `npm run tauri dev` | Desktop app in development |
| `npm run build` | Production frontend build (runs complexity budget check) |
| `npm run tauri build` | Build platform installers |
| `npm test` | Unit, CSS hygiene, i18n, capability, and carrier tests |
| `npm run eval` | Offline evaluation suite: search, quote location, number verification, PDF annotations, and OCR (see [eval/README.md](eval/README.md)) |
| `npm run perf` | Performance probe across 4 scenarios and 22 budgets |
| `npm run ui:inventory` | Verify UI budgets, contrast, layout non-clipping, and sentence tallies against a running dev server |
| `npm run check:secrets` | Pre-release secret scan |
| `npm run version:sync` | Sync `VERSION` → `package.json`, Cargo, and fallback constants |

## macOS & Windows first launch notes

The macOS universal bundle is ad-hoc signed (`signingIdentity: "-"`). If macOS Gatekeeper blocks first launch after download, run once:

```bash
xattr -dr com.apple.quarantine /Applications/PageWise.app
```

Or attempt to open PageWise once, then open **System Settings → Privacy & Security** and click **Open Anyway**. On Windows SmartScreen, choose **More info → Run anyway**. See [docs/RELEASE.md](docs/RELEASE.md) for full release and signing details.

## Architecture

```
React 19 UI  →  PagewiseChatTransport + ToolLoopAgent (Vercel AI SDK)
             →  Web Worker    →  tesseract.js (local OCR + positioned text layer)
             →  Tauri invoke  →  Rust (pdf-inspector, lopdf annotations, atomic stores, grants)
             →  OS Keychain   →  API keys (per provider)
```

## Contributing & License

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under MIT — see [LICENSE](LICENSE).
