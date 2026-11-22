import { docCache } from "./doc-cache";
import { DOCUMENT_OUTLINE_TOOL } from "./document-tool-names";
import { marksOnPage } from "./mark-store";

export interface AgentMessageContext {
  path: string;
  docName: string;
  viewingPage: number;
  totalPages: number;
  userText: string;
  includeViewingPage: boolean;
  /** User opted this message into web search (OpenRouter native). */
  webSearch?: boolean;
}

/**
 * FIFO queue of contexts awaiting consumption. A queue (rather than a single
 * slot) prevents a rapid double-send from overwriting the first message's
 * context before `prepareCall` consumes it.
 */
const pendingQueue: AgentMessageContext[] = [];
/** Hard cap so an unconsumed queue can't grow without bound. */
const MAX_PENDING = 16;
let lastMessageContext: AgentMessageContext | null = null;

export function beginAgentMessage(ctx: AgentMessageContext): void {
  pendingQueue.push(ctx);
  if (pendingQueue.length > MAX_PENDING) pendingQueue.shift();
  lastMessageContext = ctx;
}

export function rollbackLastAgentMessage(): void {
  if (pendingQueue.length === 0) return;
  pendingQueue.pop();
  lastMessageContext = pendingQueue[pendingQueue.length - 1] ?? null;
}

/**
 * Remove a SPECIFIC pending context. Prefer this over
 * {@link rollbackLastAgentMessage} in async cleanup paths: a stale send's
 * late-resolving continuation must only remove its own context — popping
 * blindly could eat the context a newer send just queued, leaving that run
 * with no active document (all tools hidden) and no per-message options.
 */
export function rollbackAgentMessage(ctx: AgentMessageContext): void {
  const idx = pendingQueue.lastIndexOf(ctx);
  if (idx < 0) return;
  pendingQueue.splice(idx, 1);
  lastMessageContext = pendingQueue[pendingQueue.length - 1] ?? null;
}

export function consumePendingAgentContext(): AgentMessageContext | null {
  return pendingQueue.shift() ?? null;
}

export function getLastAgentMessageContext(): AgentMessageContext | null {
  return lastMessageContext;
}

export function clearAgentMessageContext(): void {
  pendingQueue.length = 0;
  lastMessageContext = null;
}

/**
 * Neutralize an attacker-controlled document filename before it is interpolated
 * into the SYSTEM prompt: drop control characters / newlines that could inject
 * pseudo-instructions, collapse whitespace, and replace quote/backtick
 * characters so a name like `report" ignore prior rules.pdf` cannot break out
 * of its surrounding delimiter.
 */
export function sanitizeForPrompt(value: string, max = 200): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    // Strip C0/C1 control chars (incl. newlines, tabs) and DEL.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += " ";
      continue;
    }
    // Fold quote-like characters that could close our delimiter.
    if (ch === '"' || ch === "“" || ch === "”" || ch === "„" || ch === "‟" || ch === "`") {
      out += "'";
      continue;
    }
    out += ch;
  }
  const collapsed = out.replace(/\s+/g, " ").trim();
  const chars = [...collapsed];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : collapsed;
}

/**
 * Attach the per-message context to the newest user message.
 *
 * It used to be appended to the system prompt. The system prompt is the first
 * block of every request, and providers cache on an exact prefix — so a hint
 * containing "the user is viewing page 47" invalidated the cached prefix of the
 * entire conversation every time the reader was on a different page than last
 * time, and every turn re-charged the whole history at full price.
 *
 * Carried on the last user message instead, everything before that message is
 * byte-identical from one turn to the next, so the cache covers all of the
 * history except the turn being asked. The hint is added at call time and is
 * never stored, so it does not appear in the transcript.
 */
export function appendContextToLastUserMessage<
  M extends { role: string; content: unknown },
>(messages: readonly M[] | undefined, hint: string): M[] | readonly M[] | undefined {
  if (!messages || messages.length === 0 || !hint.trim()) return messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    const next = [...messages];
    if (typeof message.content === "string") {
      next[i] = { ...message, content: `${message.content}${hint}` };
    } else if (Array.isArray(message.content)) {
      next[i] = {
        ...message,
        content: [...message.content, { type: "text", text: hint }],
      };
    } else {
      return messages;
    }
    return next;
  }
  return messages;
}

export function buildViewContextInstructions(ctx: AgentMessageContext): string {
  const name = sanitizeForPrompt(ctx.docName);
  const path = sanitizeForPrompt(ctx.path, 400);
  const base = `\n\nActive document: "${name}" (${ctx.totalPages} pages, file: "${path}").`;
  // The page NUMBER is always shared — it is cheap text and is what makes
  // "this page" / "本页" requests resolve to the page the user is actually on.
  // The optional page *screenshot* is a separate, opt-in concern handled in the
  // send path (`includeViewingPage`), not here.
  if (ctx.viewingPage <= 0) return base;
  return `${base} The user is viewing page ${ctx.viewingPage}; read that page first for "this page"/"本页"/"当前页" requests or when the question likely refers to what they are looking at — otherwise search or read whichever pages answer the question.`;
}

export function buildWholeDocumentInstructions(ctx: AgentMessageContext): string {
  const name = sanitizeForPrompt(ctx.docName);
  const pages = ctx.totalPages > 0 ? `${ctx.totalPages} pages` : "unknown length";
  return `\n\nThis is a whole-document request ("${name}", ${pages}): use ${DOCUMENT_OUTLINE_TOOL} to plan, read the full document with read_pdf_range in chunks (continue while truncated=true) until every page is covered, then answer from all of it — not a single page. If a result reports budgetExceeded=true, stop reading and answer from the pages read, noting which pages you covered.`;
}

const MAX_DOC_MAP_CHARS = 1_200;
const MAX_VIEWING_PAGE_FALLBACK_CHARS = 3_000;

/**
 * Text fallback when the user explicitly enabled `includeViewingPage` on a
 * provider/model that cannot accept an attached page image (e.g. OpenRouter,
 * DeepSeek, text-only Ollama/OpenAI models).
 */
export function buildViewingPageTextFallback(docPath: string | null, viewingPage: number): string {
  if (!docPath || viewingPage <= 0) return "";
  const pages = docCache.getPages(docPath);
  const entry = pages.find((p) => p.page === viewingPage);
  const text = entry?.text.trim() ?? "";
  if (!text) return "";
  const clipped =
    text.length > MAX_VIEWING_PAGE_FALLBACK_CHARS
      ? `${text.slice(0, MAX_VIEWING_PAGE_FALLBACK_CHARS)}… [truncated]`
      : text;
  return `\n\nViewed page ${viewingPage} text:\n${clipped}`;
}

function formatCompactRanges(pages: readonly number[]): string {
  const sorted = [...new Set(pages.filter((p) => Number.isInteger(p) && p >= 1))].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const parts: string[] = [];
  let start = sorted[0]!;
  let prev = start;
  for (let i = 1; i < sorted.length; i += 1) {
    const cur = sorted[i]!;
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = cur;
    prev = cur;
  }
  parts.push(start === prev ? `${start}` : `${start}–${prev}`);
  return parts.join(", ");
}

/**
 * Compact, cache-safe Turn-1 Document Map (<= 1,200 chars) riding on the user
 * message hint so the model immediately knows the top-20 section map, table and
 * figure pages, unindexed scan pages, and any marks on the viewed page without
 * burning a round-trip on `document_outline` or busting the system prompt cache.
 */
export function buildDocumentMapInstructions(docPath: string | null, viewingPage = 0): string {
  if (!docPath) return "";
  const doc = docCache.get(docPath);
  if (!doc || doc.kind !== "pdf") return "";

  const lines: string[] = [];
  if (doc.outline && doc.outline.length > 0) {
    const items = doc.outline.slice(0, 20).map((h) => {
      const prefix = h.level > 1 ? "  " : "";
      return `${prefix}p${h.page} ${sanitizeForPrompt(h.title, 56)}`;
    });
    const more = doc.outline.length > 20 ? ` (+${doc.outline.length - 20} more via ${DOCUMENT_OUTLINE_TOOL})` : "";
    lines.push(`Outline: ${items.join(" | ")}${more}`);
  }

  if (doc.tablePages && doc.tablePages.length > 0) {
    lines.push(`Tables on pp. ${formatCompactRanges(doc.tablePages)}`);
  }

  if (doc.figures && doc.figures.length > 0) {
    const figPages = doc.figures.map((f) => f.page);
    lines.push(`Figures on pp. ${formatCompactRanges(figPages)}`);
  }

  if (doc.totalPages > 0) {
    const hasText = new Set(doc.pages.filter((p) => p.text.trim().length > 0).map((p) => p.page));
    const blank: number[] = [];
    for (let p = 1; p <= doc.totalPages && blank.length <= 60; p += 1) {
      if (!hasText.has(p)) blank.push(p);
    }
    if (blank.length > 0) {
      lines.push(`Unindexed/scan pp. ${formatCompactRanges(blank)}`);
    }
  }

  if (viewingPage > 0) {
    const marks = marksOnPage(docPath, viewingPage).slice(0, 3);
    if (marks.length > 0) {
      const formatted = marks.map((m) => {
        const quote = sanitizeForPrompt(m.text, 80);
        const note = m.note ? ` (note: ${sanitizeForPrompt(m.note, 60)})` : "";
        return `'${quote}'${note}`;
      });
      lines.push(`Reader marks on p${viewingPage}: ${formatted.join("; ")}`);
    }
  }

  if (lines.length === 0) return "";
  let block = `\n\nDocument map:\n${lines.map((l) => `- ${l}`).join("\n")}`;
  if (block.length > MAX_DOC_MAP_CHARS) {
    block = `${block.slice(0, MAX_DOC_MAP_CHARS - 1)}…`;
  }
  return block;
}
