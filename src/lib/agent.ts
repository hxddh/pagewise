import { extractPageText } from "./pdf";
import { ToolLoopAgent, stepCountIs, tool } from "ai";
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
import { DEFAULT_SETTINGS, type LoadedDocument } from "./types";
import { indexPageText } from "./vision-index";
import { yieldToUi } from "./yield-to-ui";

/** Default cap per read_pdf_range call — keeps tool results out of context blowups. */
export const DEFAULT_RANGE_MAX_CHARS = 12_000;
/** Default cap per read_pdf_page call. */
export const DEFAULT_PAGE_MAX_CHARS = 12_000;
/** Explicit ceiling on tool-loop steps so a run always terminates. */
const MAX_AGENT_STEPS = 24;
/** Cumulative characters a single run may read before it must synthesize. */
const RUN_CHAR_BUDGET = 120_000;

/** Mutable per-run read budget shared between a run's tools and prepareCall. */
interface ReadBudget {
  used: number;
  readonly max: number;
}

/** Reject any model-supplied path that is not a currently-loaded document. */
function requireLoadedDoc(path: string): LoadedDocument {
  const doc = docCache.get(path);
  if (!doc) {
    throw new Error(
      `path not in loaded documents: "${path}". Call list_documents to get valid paths.`,
    );
  }
  return doc;
}

/** Validate a 1-based page against the document's page count. */
function assertPageInBounds(doc: LoadedDocument, page: number): void {
  // totalPages === 0 means the count is unknown; allow and let extraction cope.
  if (doc.totalPages > 0 && page > doc.totalPages) {
    throw new Error(
      `page ${page} is out of range: "${doc.name}" has ${doc.totalPages} page(s).`,
    );
  }
}

async function readPageText(path: string, page: number) {
  const doc = docCache.get(path);
  const kind = doc?.kind ?? (path.split(".").pop()?.toLowerCase() === "pdf" ? "pdf" : "image");

  const cached = docCache.getPages(path).find((p) => p.page === page);
  if (cached?.text.trim()) {
    return { page, text: cached.text, source: "cache" as const };
  }

  if (kind === "pdf") {
    const text = await extractPageText(path, page);
    if (text.trim()) {
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

const BUDGET_NOTE =
  "Cumulative read budget for this turn reached; synthesize your answer from the pages already read instead of reading more.";

/** Wrap tool execution so WebKit can paint streaming UI between agent steps. */
function bindToolExecute<T, R>(fn: (input: T) => Promise<R>): (input: T) => Promise<R> {
  return async (input) => {
    await yieldToUi();
    try {
      return await fn(input);
    } finally {
      await yieldToUi();
    }
  };
}

function createDocumentTools(budget: ReadBudget) {
  return {
    list_documents: tool({
      description: "List all documents currently loaded in the session",
      inputSchema: z.object({}),
      execute: bindToolExecute(async () =>
        docCache.list().map((d) => ({
          path: d.path,
          name: d.name,
          kind: d.kind,
          totalPages: d.totalPages,
          totalChars: d.pages.reduce((sum, p) => sum + p.text.length, 0),
        })),
      ),
    }),

    get_document_index: tool({
      description:
        "Lightweight document overview: per-page character counts and short previews. " +
        "Use before reading large documents to plan chunked reads.",
      inputSchema: z.object({
        path: z.string().describe("Path of a loaded document (from list_documents)"),
      }),
      execute: bindToolExecute(async ({ path }) => {
        const doc = requireLoadedDoc(path);
        const pages = docCache.getPages(path);
        const pageStats = pages.map((p) => ({
          page: p.page,
          chars: p.text.length,
          preview: p.text.trim().slice(0, 160),
        }));
        const totalChars = pageStats.reduce((sum, p) => sum + p.chars, 0);
        return {
          totalPages: doc.totalPages || pages.length,
          totalChars,
          suggestedChunkSize: DEFAULT_RANGE_MAX_CHARS,
          needsChunking: totalChars > DEFAULT_RANGE_MAX_CHARS,
          pages: pageStats,
        };
      }),
    }),

    read_pdf_page: tool({
      description:
        "Read text from a specific page of a loaded document (1-based page number). " +
        "For very long pages the output is capped at maxChars; when truncated=true, call again " +
        "with offset=nextOffset to continue the same page.",
      inputSchema: z.object({
        path: z.string().describe("Path of a loaded document (from list_documents)"),
        page: z.number().int().min(1),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Character offset into the page to resume from (a previous nextOffset)"),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(50_000)
          .optional()
          .describe(`Max characters to return (default ${DEFAULT_PAGE_MAX_CHARS})`),
      }),
      execute: bindToolExecute(async ({ path, page, offset = 0, maxChars = DEFAULT_PAGE_MAX_CHARS }) => {
        const doc = requireLoadedDoc(path);
        assertPageInBounds(doc, page);

        if (budget.used >= budget.max) {
          return {
            page,
            text: "",
            source: "cache" as const,
            truncated: false,
            nextOffset: null,
            charCount: 0,
            budgetExceeded: true,
            note: BUDGET_NOTE,
          };
        }

        const { text, source } = await readPageText(path, page);
        const from = Math.min(offset, text.length);
        const room = Math.min(maxChars, budget.max - budget.used);
        const slice = text.slice(from, from + room);
        budget.used += slice.length;

        const consumedEnd = from + slice.length;
        const truncated = consumedEnd < text.length;
        const limitedByBudget = truncated && budget.used >= budget.max;

        return {
          page,
          text: slice,
          source,
          truncated,
          nextOffset: truncated ? consumedEnd : null,
          charCount: slice.length,
          ...(limitedByBudget ? { budgetExceeded: true, note: BUDGET_NOTE } : {}),
        };
      }),
    }),

    read_pdf_range: tool({
      description:
        "Read text from a page range (inclusive, 1-based). " +
        "For large documents use maxChars (default 12000) and continue when truncated=true: call again " +
        "with start=nextStart, and pass offset=nextOffset when it is non-null (the same page has more text). " +
        "truncated=false (with nextStart=null) means the range is fully read.",
      inputSchema: z.object({
        path: z.string().describe("Path of a loaded document (from list_documents)"),
        start: z.number().int().min(1),
        end: z.number().int().min(1),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Character offset into the start page to resume from (a previous nextOffset)"),
        maxChars: z
          .number()
          .int()
          .min(2000)
          .max(50_000)
          .optional()
          .describe(`Max characters to return (default ${DEFAULT_RANGE_MAX_CHARS})`),
      }),
      execute: bindToolExecute(async ({
        path,
        start,
        end,
        offset = 0,
        maxChars = DEFAULT_RANGE_MAX_CHARS,
      }) => {
        const doc = requireLoadedDoc(path);
        const from = Math.min(start, end);
        const to = Math.max(start, end);
        assertPageInBounds(doc, from);

        const pageLimit = doc.totalPages > 0 ? Math.min(to, doc.totalPages) : to;

        const parts: string[] = [];
        let charCount = 0;
        let lastPage = from;
        let truncated = false;
        let nextStart: number | null = null;
        let nextOffset: number | null = null;
        let budgetExceeded = false;

        for (let page = from; page <= pageLimit; page++) {
          // Fast path: stop before reading if the run budget is already spent.
          if (budget.used >= budget.max) {
            truncated = true;
            nextStart = page;
            nextOffset = page === from ? offset : 0;
            budgetExceeded = true;
            break;
          }

          const { text } = await readPageText(path, page);
          const pageOffset = page === from ? Math.min(offset, text.length) : 0;
          const remainingText = text.slice(pageOffset);
          const header = `--- Page ${page}${pageOffset > 0 ? " (cont.)" : ""} ---\n`;
          const separator = parts.length > 0 ? 2 : 0;

          const maxRoom = maxChars - charCount - separator - header.length;
          const budgetRoom = budget.max - budget.used - separator - header.length;
          const room = Math.min(maxRoom, budgetRoom);
          const limitedByBudget = budgetRoom <= maxRoom;

          if (room <= 0) {
            // No room for this page's header+content in this call; resume here.
            truncated = true;
            nextStart = page;
            nextOffset = pageOffset;
            budgetExceeded = limitedByBudget;
            break;
          }

          if (remainingText.length > room) {
            const slice = remainingText.slice(0, room);
            parts.push(header + slice);
            charCount += separator + header.length + slice.length;
            budget.used += slice.length;
            lastPage = page;
            truncated = true;
            nextStart = page;
            nextOffset = pageOffset + slice.length;
            budgetExceeded = limitedByBudget;
            break;
          }

          parts.push(header + remainingText);
          charCount += separator + header.length + remainingText.length;
          budget.used += remainingText.length;
          lastPage = page;
        }

        return {
          text: parts.join("\n\n"),
          truncated,
          nextStart,
          nextOffset,
          startPage: from,
          endPage: lastPage,
          charCount,
          ...(budgetExceeded ? { budgetExceeded: true, note: BUDGET_NOTE } : {}),
        };
      }),
    }),

    search_in_document: tool({
      description: "Search for a keyword or phrase in a loaded document",
      inputSchema: z.object({
        path: z.string().describe("Path of a loaded document (from list_documents)"),
        query: z.string().min(1),
      }),
      execute: bindToolExecute(async ({ path, query }) => {
        requireLoadedDoc(path);
        return docCache.search(path, query);
      }),
    }),
  };
}

const SYSTEM_INSTRUCTIONS = `You are PageWise, a local desktop document assistant.
You help users understand PDFs and images stored on their machine.

Rules:
- Always use tools to read document content; never invent page text.
- Only read documents returned by list_documents; pass their exact path. Never invent file paths.
- Document pages are pre-indexed from images and scans. Use read_pdf_page / read_pdf_range on indexed text.
- If a page returns empty text, indexing may still be running, or the user may need a multimodal model in Settings → AI Provider (e.g. gpt-4o-mini, Qwen2.5-VL). Do not ask them to install Tesseract.
- For whole-document summary or analysis (全文, 总结, 分析整份文档): call get_document_index first.
  If totalChars ≤ 12000, one read_pdf_range is enough. Otherwise read in chunks with maxChars=12000,
  continuing from nextStart (and pass offset=nextOffset when it is non-null — the same page still has text)
  until truncated=false, then synthesize.
- If any tool result includes budgetExceeded=true, stop reading and answer from the pages already read.
- Do NOT use search_in_document for whole-document summaries.
- When the user refers to the current page (这一页, 当前页, this page), use read_pdf_page for that page.
- For targeted questions, use search_in_document first, then read only the pages you need.
- Cite page numbers when quoting document content.
- If no document is loaded, ask the user to open a file first.`;

export function createDocAgent() {
  const budget: ReadBudget = { used: 0, max: RUN_CHAR_BUDGET };
  const tools = createDocumentTools(budget);

  return new ToolLoopAgent({
    model: resolveModel(DEFAULT_SETTINGS),
    instructions: SYSTEM_INSTRUCTIONS,
    tools,
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
    prepareCall: async ({ toolsContext, ...rest }) => {
      // Reset the per-run read budget at the start of each run.
      budget.used = 0;

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

export const documentTools = createDocumentTools({ used: 0, max: RUN_CHAR_BUDGET });
