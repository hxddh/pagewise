export interface AgentMessageContext {
  path: string;
  docName: string;
  viewingPage: number;
  totalPages: number;
  userText: string;
  includeViewingPage: boolean;
}

let pendingContext: AgentMessageContext | null = null;
let lastMessageContext: AgentMessageContext | null = null;

export function beginAgentMessage(ctx: AgentMessageContext): void {
  pendingContext = ctx;
  lastMessageContext = ctx;
}

export function consumePendingAgentContext(): AgentMessageContext | null {
  const ctx = pendingContext;
  pendingContext = null;
  return ctx;
}

export function getLastAgentMessageContext(): AgentMessageContext | null {
  return lastMessageContext;
}

export function clearAgentMessageContext(): void {
  pendingContext = null;
  lastMessageContext = null;
}

export function buildViewContextInstructions(ctx: AgentMessageContext): string {
  if (!ctx.includeViewingPage) {
    return `

Document context (this message only):
- Document: "${ctx.docName}" (${ctx.totalPages} pages, file: ${ctx.path})`;
  }

  return `

View context (this message only):
- Document: "${ctx.docName}"
- User is viewing page ${ctx.viewingPage} of ${ctx.totalPages} (file: ${ctx.path})

Page selection rules:
- If the user means "this page", "current page", "这一页", "当前页", or similar, call read_pdf_page for page ${ctx.viewingPage}.
- If they name a different page number, read that page instead.
- For general questions without a page reference, use search_in_document first; only default to page ${ctx.viewingPage} when the question clearly concerns visible on-screen content.`;
}

export function buildWholeDocumentInstructions(ctx: AgentMessageContext): string {
  return `

Whole-document request (${ctx.totalPages} pages in "${ctx.docName}"):
1. Call get_document_index once — do not skip this for large documents.
2. If totalChars ≤ 12000: read_pdf_range(path, 1, ${ctx.totalPages}) in one call.
3. If totalChars > 12000: read_pdf_range with maxChars=12000; when truncated=true, call again with start=nextStart until done.
4. Do NOT use search_in_document. Do NOT answer from only page ${ctx.viewingPage}.
5. After all chunks are read, write one synthesized answer.`;
}
