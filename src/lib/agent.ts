import { invoke } from "@tauri-apps/api/core";
import { ToolLoopAgent } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { docCache } from "./doc-cache";
import { resolveModel } from "./llm";
import { ocrPdfPage } from "./pdf";
import { loadSettings } from "./settings";

async function readPageText(path: string, page: number) {
  const cached = docCache.getPages(path).find((p) => p.page === page);
  if (cached?.text.trim()) {
    return { page, text: cached.text, source: "cache" as const };
  }

  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "pdf") {
    const result = await invoke<{ pages: { page: number; text: string }[] }>(
      "extract_pdf_text_cmd",
      { path, page },
    );
    const text = result.pages[0]?.text ?? "";
    if (text.trim().length >= 20) {
      return { page, text, source: "pdf-text" as const };
    }
    const ocrText = await ocrPdfPage(path, page);
    return { page, text: ocrText, source: "ocr" as const };
  }

  const text = await invoke<string>("ocr_image", { path });
  return { page: 1, text, source: "ocr" as const };
}

const tools = {
  list_documents: tool({
    description: "List all documents currently loaded in the session",
    inputSchema: z.object({}),
    execute: async () =>
      docCache.list().map((d) => ({
        path: d.path,
        name: d.name,
        kind: d.kind,
        totalPages: d.totalPages,
      })),
  }),

  read_pdf_page: tool({
    description: "Read text from a specific page of a loaded document (1-based page number)",
    inputSchema: z.object({
      path: z.string().describe("Absolute file path"),
      page: z.number().int().min(1),
    }),
    execute: async ({ path, page }) => readPageText(path, page),
  }),

  read_pdf_range: tool({
    description: "Read text from a range of pages (inclusive, 1-based)",
    inputSchema: z.object({
      path: z.string(),
      start: z.number().int().min(1),
      end: z.number().int().min(1),
    }),
    execute: async ({ path, start, end }) => {
      const from = Math.min(start, end);
      const to = Math.max(start, end);
      const parts: string[] = [];
      for (let page = from; page <= to; page++) {
        const { text } = await readPageText(path, page);
        parts.push(`--- Page ${page} ---\n${text}`);
      }
      return parts.join("\n\n");
    },
  }),

  search_in_document: tool({
    description: "Search for a keyword or phrase in a loaded document",
    inputSchema: z.object({
      path: z.string(),
      query: z.string().min(1),
    }),
    execute: async ({ path, query }) => docCache.search(path, query),
  }),

  ocr_file: tool({
    description: "Run OCR on an image file path",
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }) => invoke<string>("ocr_image", { path }),
  }),
};

const SYSTEM_INSTRUCTIONS = `You are PageWise, a local desktop document assistant.
You help users understand PDFs and images stored on their machine.

Rules:
- Always use tools to read document content; never invent page text.
- Prefer read_pdf_page for single pages and search_in_document before reading long ranges.
- Cite page numbers when quoting document content.
- If no document is loaded, ask the user to open a file first.`;

export function createDocAgent() {
  return new ToolLoopAgent({
    model: resolveModel(),
    instructions: SYSTEM_INSTRUCTIONS,
    tools,
    prepareCall: async ({ toolsContext, ...rest }) => {
      const settings = await loadSettings();
      return {
        ...rest,
        model: resolveModel(settings),
        toolsContext,
      };
    },
  });
}

export { tools as documentTools };
