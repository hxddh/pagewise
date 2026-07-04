export interface AgentMessageContext {
  path: string;
  docName: string;
  viewingPage: number;
  totalPages: number;
  userText: string;
  includeViewingPage: boolean;
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
  if (!ctx.includeViewingPage) {
    return `

Document context (this message only):
- Document: "${name}" (${ctx.totalPages} pages, file: "${path}")`;
  }

  return `

View context (this message only):
- Document: "${name}"
- User is viewing page ${ctx.viewingPage} of ${ctx.totalPages} (file: "${path}")

Page selection rules:
- If the user means "this page", "current page", "这一页", "当前页", or similar, call read_pdf_page for page ${ctx.viewingPage}.
- If they name a different page number, read that page instead.
- For general questions without a page reference, use search_in_document first; only default to page ${ctx.viewingPage} when the question clearly concerns visible on-screen content.
- If a path is rejected as "not in loaded documents", call list_documents to obtain the exact path.`;
}

export function buildWholeDocumentInstructions(ctx: AgentMessageContext): string {
  const name = sanitizeForPrompt(ctx.docName);
  const pages = ctx.totalPages > 0 ? ctx.totalPages : "unknown";
  const rangeEnd = ctx.totalPages > 0 ? String(ctx.totalPages) : "totalPages from get_document_index";
  return `

Whole-document request (${pages} pages in "${name}"):
1. Call get_document_index once — do not skip this for large documents or when page count is unknown.
2. If totalChars ≤ 12000: read_pdf_range(path, 1, ${rangeEnd}) in one call.
3. If totalChars > 12000: read_pdf_range with maxChars=12000; when truncated=true, call again with start=nextStart (and offset=nextOffset when it is non-null) until truncated=false.
4. Do NOT use search_in_document. Do NOT answer from only page ${ctx.viewingPage}.
5. After all chunks are read, write one synthesized answer.`;
}
