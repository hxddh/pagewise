import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { READ_PDF_PAGE_TOOL, READ_PDF_RANGE_TOOL } from "./document-tool-names";

/** Cap range expansion so a whole-document read can't produce an unbounded list. */
const MAX_PAGES = 300;

/**
 * Collect the distinct, sorted page numbers an assistant turn actually read via
 * its read tools (read_pdf_page / read_pdf_range), so the UI can show a "pages
 * read" trail that grounds the answer in the document. Pure — unit-testable
 * without a live model.
 */
export function collectReadPages(parts: UIMessage["parts"] | undefined): number[] {
  if (!Array.isArray(parts)) return [];
  const set = new Set<number>();
  for (const part of parts) {
    if (!isToolUIPart(part)) continue;
    if (part.state !== "input-available" && part.state !== "output-available") continue;
    const name = getToolName(part);
    const input =
      part.input && typeof part.input === "object"
        ? (part.input as Record<string, unknown>)
        : {};

    if (name === READ_PDF_PAGE_TOOL && typeof input.page === "number") {
      if (Number.isInteger(input.page) && input.page > 0) set.add(input.page);
    } else if (name === READ_PDF_RANGE_TOOL && typeof input.start === "number") {
      const start = input.start;
      const end = typeof input.end === "number" && input.end >= start ? input.end : start;
      for (let pg = start; pg <= end && set.size < MAX_PAGES; pg++) {
        if (Number.isInteger(pg) && pg > 0) set.add(pg);
      }
    }
  }
  return [...set].sort((a, b) => a - b);
}
