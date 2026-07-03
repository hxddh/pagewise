# PageWise

Local desktop document agent for **PDF text extraction**, **OCR**, and **page-wise AI analysis**.

Built with **Tauri 2**, **React**, and the [Vercel AI SDK](https://ai-sdk.dev). Documents are processed on your machine; only extracted text is sent to the LLM you configure.

## Features (v0.1)

- Open PDFs and images from disk (**file picker** or **drag & drop**)
- **PDF preview** with page navigation, **thumbnail sidebar**, zoom, and page jump
- **In-document search** (⌘F) with jump-to-page results
- **Recent files** list (persisted locally)
- Loading **progress overlay** and success/error **toasts**
- **Image preview** for OCR'd image files
- Extract PDF text layers locally (Rust `pdf-extract`)
- OCR images and scanned PDF pages (system Tesseract)
- Streaming chat agent with **tool call visualization** (input/output, status)
- Preview auto-jumps to the page the agent is reading
- Multi-provider LLM via a single OpenAI-compatible client (`@ai-sdk/openai`):
  - OpenAI, DeepSeek, OpenRouter, Ollama, or any custom compatible endpoint
- API keys stored locally with `tauri-plugin-store`

## Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Rust](https://www.rust-lang.org/tools/install)
- **Tesseract** (for OCR):

```bash
brew install tesseract tesseract-lang
```

## Development

```bash
git clone https://github.com/hxddh/pagewise.git
cd pagewise
npm install
npm run tauri dev
```

## Configuration

1. Open **Settings** in the app
2. Choose a provider (DeepSeek, OpenRouter, OpenAI, Ollama, or Custom)
3. Enter your API key and model id
4. Click **Test connection**, then **Save**

## Architecture

```
React UI  →  Vercel AI SDK (DirectChatTransport + ToolLoopAgent)
          →  Tauri invoke  →  Rust (pdf-extract, Tesseract CLI)
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server only |
| `npm run tauri dev` | Desktop app (recommended) |
| `npm run tauri build` | Production build |

## License

MIT
