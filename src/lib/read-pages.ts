import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { READ_PDF_PAGE_TOOL, READ_PDF_RANGE_TOOL } from "./document-tool-names";

/** Cap range expansion so a whole-document read can't produce an unbounded list. */
const MAX_PAGES = 300;

/** A read whose output shows it never delivered any page text. */
function outputShowsNothingRead(output: unknown): boolean {
  if (output === "[cancelled]") return true;
  if (output && typeof output === "object") {
    const o = output as { budgetExceeded?: unknown; charCount?: unknown };
    if (o.budgetExceeded === true && o.charCount === 0) return true;
  }
  return false;
}

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
    const output =
      part.state === "output-available" && "output" in part ? part.output : undefined;
    // Cancelled / budget-refused reads never delivered text — claiming those
    // pages as "read" would overstate the answer's grounding.
    if (output !== undefined && outputShowsNothingRead(output)) continue;

    if (name === READ_PDF_PAGE_TOOL && typeof input.page === "number") {
      if (Number.isInteger(input.page) && input.page > 0) set.add(input.page);
    } else if (name === READ_PDF_RANGE_TOOL && typeof input.start === "number") {
      let start = input.start;
      let end = typeof input.end === "number" && input.end >= start ? input.end : start;
      // Prefer the pages the tool REPORTED reading: a range truncated by
      // maxChars or the run budget stops early (endPage < requested end).
      if (output && typeof output === "object") {
        const o = output as { startPage?: unknown; endPage?: unknown };
        if (
          typeof o.startPage === "number" &&
          typeof o.endPage === "number" &&
          o.endPage >= o.startPage
        ) {
          start = o.startPage;
          end = o.endPage;
        }
      }
      // Integer guard doubles as a loop bound: with a fractional start no page
      // is ever added, so `set.size < MAX_PAGES` alone would not bound a
      // malformed huge range.
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1) continue;
      end = Math.min(end, start + MAX_PAGES);
      for (let pg = start; pg <= end && set.size < MAX_PAGES; pg++) {
        set.add(pg);
      }
    }
  }
  return [...set].sort((a, b) => a - b);
}
