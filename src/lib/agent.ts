import { invoke } from "@tauri-apps/api/core";
import { ToolLoopAgent } from "ai";
import { tool } from "ai";
import { z } from "zod";
import {
  buildViewContextInstructions,
  buildWholeDocumentInstructions,
  consumePendingAgentContext,
} from "./agent-view-context";
import { docCache } from "./doc-cache";
import { resolveModel } from "./llm";
import { hasWholeDocumentIntent } from "./page-intent";
import { loadSettings } from "./settings";
import { DEFAULT_SETTINGS } from "./types";
import { indexPageText, MIN_INDEX_CHARS } from "./vision-index";

/** Default cap per read_pdf_range call — keeps tool results out of context blowups. */
export const DEFAULT_RANGE_MAX_CHARS = 12_000;

async function readPageText(path: string, page: number) {
  const doc = docCache.get(path);
  const kind = doc?.kind ?? (path.split(".").pop()?.toLowerCase() === "pdf" ? "pdf" : "image");

  const cached = docCache.getPages(path).find((p) => p.page === page);
  if (cached && cached.text.trim().length >= MIN_INDEX_CHARS) {
    return { page, text: cached.text, source: "cache" as const };
  }

  if (kind === "pdf") {
    const result = await invoke<{ pages: { page: number; text: string }[] }>(
      "extract_pdf_text_cmd",
      { path, page },
    );
    const text = result.pages[0]?.text ?? "";
    if (text.trim().length >= MIN_INDEX_CHARS) {
      docCache.upsertPageText(path, page, text);
      return { page, text, source: "pdf-text" as const };
    }
  }

  const indexed = await indexPageText(path, page, kind);
  return {
    page,
    text: indexed.text,
    source: indexed.source === "vision" ? ("vision" as const) : ("ocr" as const),
  };
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
        totalChars: d.pages.reduce((sum, p) => sum + p.text.length, 0),
      })),
  }),

  get_document_index: tool({
    description:
      "Lightweight document overview: per-page character counts and short previews. " +
      "Use before reading large documents to plan chunked reads.",
    inputSchema: z.object({
      path: z.string().describe("Absolute file path"),
    }),
    execute: async ({ path }) => {
      const doc = docCache.get(path);
      const pages = docCache.getPages(path);
      const pageStats = pages.map((p) => ({
        page: p.page,
        chars: p.text.length,
        preview: p.text.trim().slice(0, 160),
      }));
      const totalChars = pageStats.reduce((sum, p) => sum + p.chars, 0);
      return {
        totalPages: doc?.totalPages ?? pages.length,
        totalChars,
        suggestedChunkSize: DEFAULT_RANGE_MAX_CHARS,
        needsChunking: totalChars > DEFAULT_RANGE_MAX_CHARS,
        pages: pageStats,
      };
    },
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
    description:
      "Read text from a page range (inclusive, 1-based). " +
      "For large documents use maxChars (default 12000) and continue from nextStart when truncated.",
    inputSchema: z.object({
      path: z.string(),
      start: z.number().int().min(1),
      end: z.number().int().min(1),
      maxChars: z
        .number()
        .int()
        .min(2000)
        .max(50_000)
        .optional()
        .describe(`Max characters to return (default ${DEFAULT_RANGE_MAX_CHARS})`),
    }),
    execute: async ({ path, start, end, maxChars = DEFAULT_RANGE_MAX_CHARS }) => {
      const from = Math.min(start, end);
      const to = Math.max(start, end);
      const doc = docCache.get(path);
      const pageLimit = doc?.totalPages ?? to;

      const parts: string[] = [];
      let charCount = 0;
      let lastPageIncluded = from;
      let truncated = false;

      for (let page = from; page <= to && page <= pageLimit; page++) {
        const { text } = await readPageText(path, page);
        const block = `--- Page ${page} ---\n${text}`;
        const separator = parts.length > 0 ? 2 : 0;

        if (charCount + separator + block.length > maxChars) {
          if (parts.length === 0) {
            const header = `--- Page ${page} ---\n`;
            const allowed = Math.max(0, maxChars - header.length);
            parts.push(header + text.slice(0, allowed));
            charCount = header.length + Math.min(text.length, allowed);
            lastPageIncluded = page;
            truncated = text.length > allowed || page < to;
          } else {
            truncated = true;
          }
          break;
        }

        parts.push(block);
        charCount += separator + block.length;
        lastPageIncluded = page;
      }

      const hasMoreInRange = truncated && lastPageIncluded < Math.min(to, pageLimit);
      const nextStart = hasMoreInRange ? lastPageIncluded + 1 : null;

      return {
        text: parts.join("\n\n"),
        truncated,
        nextStart,
        startPage: from,
        endPage: lastPageIncluded,
        charCount,
      };
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
};

const SYSTEM_INSTRUCTIONS = `You are PageWise, a local desktop document assistant.
You help users understand PDFs and images stored on their machine.

Rules:
- Always use tools to read document content; never invent page text.
- Document pages are pre-indexed from images and scans. Use read_pdf_page / read_pdf_range on indexed text.
- If a page returns empty text, indexing may still be running, or the user may need a multimodal model in Settings → AI Provider (e.g. gpt-4o-mini, Qwen2.5-VL). Do not ask them to install Tesseract.
- For whole-document summary or analysis (全文, 总结, 分析整份文档): call get_document_index first.
  If totalChars ≤ 12000, one read_pdf_range is enough. Otherwise read in chunks with maxChars=12000
  and continue from nextStart until truncated=false, then synthesize.
- Do NOT use search_in_document for whole-document summaries.
- When the user refers to the current page (这一页, 当前页, this page), use read_pdf_page for that page.
- For targeted questions, use search_in_document first, then read only the pages you need.
- Cite page numbers when quoting document content.
- If no document is loaded, ask the user to open a file first.`;

export function createDocAgent() {
  return new ToolLoopAgent({
    model: resolveModel(DEFAULT_SETTINGS),
    instructions: SYSTEM_INSTRUCTIONS,
    tools,
    prepareCall: async ({ toolsContext, ...rest }) => {
      const settings = await loadSettings();
      const viewCtx = consumePendingAgentContext();
      let viewHint = viewCtx ? buildViewContextInstructions(viewCtx) : "";

      if (viewCtx && hasWholeDocumentIntent(viewCtx.userText)) {
        viewHint += buildWholeDocumentInstructions(viewCtx);
      }

      return {
        ...rest,
        model: resolveModel(settings),
        instructions: SYSTEM_INSTRUCTIONS + viewHint,
        toolsContext,
      };
    },
  });
}

export { tools as documentTools };
