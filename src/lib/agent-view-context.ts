import { DOCUMENT_OUTLINE_TOOL } from "./document-tool-names";

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
function sanitizeForPrompt(value: string, max = 200): string {
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
