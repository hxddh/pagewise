/** Single source of truth for agent document tool identifiers. */
export const DOCUMENT_OUTLINE_TOOL = "document_outline" as const;
export const READ_PDF_PAGE_TOOL = "read_pdf_page" as const;
export const READ_PDF_RANGE_TOOL = "read_pdf_range" as const;
export const SEARCH_IN_DOCUMENT_TOOL = "search_in_document" as const;
export const READ_FIGURE_TOOL = "read_figure" as const;
export const READ_SECTION_TOOL = "read_section" as const;
export const NOTE_FINDING_TOOL = "note_finding" as const;
export const REVISE_FINDING_TOOL = "revise_finding" as const;

export const DOCUMENT_TOOL_NAMES = [
  DOCUMENT_OUTLINE_TOOL,
  READ_PDF_PAGE_TOOL,
  READ_PDF_RANGE_TOOL,
  SEARCH_IN_DOCUMENT_TOOL,
  READ_FIGURE_TOOL,
  READ_SECTION_TOOL,
  NOTE_FINDING_TOOL,
  REVISE_FINDING_TOOL,
] as const;

export type DocumentToolName = (typeof DOCUMENT_TOOL_NAMES)[number];

/** Tool outputs replaced with compact summaries in persisted / follow-up chat history. */
export const PRUNE_DOCUMENT_TOOLS: ReadonlySet<DocumentToolName> = new Set([
  READ_PDF_PAGE_TOOL,
  READ_PDF_RANGE_TOOL,
  SEARCH_IN_DOCUMENT_TOOL,
  DOCUMENT_OUTLINE_TOOL,
  READ_SECTION_TOOL,
]);

// NOTE_FINDING_TOOL and REVISE_FINDING_TOOL are absent for a different reason
// than READ_FIGURE_TOOL: their results are already tiny — a flag, an id and a
// page list — so pruning them would save nothing, and the id is what a later
// revise_finding call has to name. Compacting it away would leave the agent
// able to see it was wrong and unable to say which claim it was wrong about.
//
// READ_FIGURE_TOOL is deliberately absent. Everything above can be recovered
// for free — page text is in the cache, search re-runs locally — so dropping it
// from history costs nothing but tokens. A figure description exists only
// because a billed vision call produced it; pruning it invites the model to
// pay for the same image again on a later turn.
