/** Single source of truth for agent document tool identifiers. */
export const DOCUMENT_OUTLINE_TOOL = "document_outline" as const;
export const READ_PDF_PAGE_TOOL = "read_pdf_page" as const;
export const READ_PDF_RANGE_TOOL = "read_pdf_range" as const;
export const SEARCH_IN_DOCUMENT_TOOL = "search_in_document" as const;

export const DOCUMENT_TOOL_NAMES = [
  DOCUMENT_OUTLINE_TOOL,
  READ_PDF_PAGE_TOOL,
  READ_PDF_RANGE_TOOL,
  SEARCH_IN_DOCUMENT_TOOL,
] as const;

export type DocumentToolName = (typeof DOCUMENT_TOOL_NAMES)[number];

/** Tool outputs replaced with compact summaries in persisted / follow-up chat history. */
export const PRUNE_DOCUMENT_TOOLS: ReadonlySet<DocumentToolName> = new Set([
  READ_PDF_PAGE_TOOL,
  READ_PDF_RANGE_TOOL,
  SEARCH_IN_DOCUMENT_TOOL,
  DOCUMENT_OUTLINE_TOOL,
]);
