import { tool } from "ai";
import { z } from "zod";
import { findSectionIndex, sectionRange } from "../../section-range";
import * as R from "../reading";
import type { ReadBudget } from "../reading";

/** The `read_section` tool. Everything shared with the other five lives in ../reading. */
export function createReadSectionTool(
  budget: ReadBudget,
  chargeBudget: (runGen: number, chars: number) => void,
) {
  return tool({
      description:
        "Read a whole section by its heading, instead of guessing which pages it " +
        "spans. Take the heading from document_outline. Continue exactly as with " +
        "read_pdf_range when truncated=true: nextStart/nextOffset say where to " +
        "resume. Section boundaries come from the document's own bookmarks when it " +
        "has them, otherwise from headings recovered from the page text, which on " +
        "a document whose headings are not visually distinct can be approximate — " +
        "fall back to read_pdf_range when the result looks wrong.",
      inputSchema: z.object({
        title: z.string().min(1).describe("Heading text, as document_outline reported it"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Character offset into the first page to resume from (a previous nextOffset)"),
        maxChars: z
          .number()
          .int()
          .min(2000)
          .max(50_000)
          .optional()
          .describe(`Max characters to return (default ${R.DEFAULT_RANGE_MAX_CHARS})`),
      }),
      contextSchema: R.docToolContextSchema,
      execute: R.bindToolExecute(
        ({ title }) => ({
          message: `Reading section “${title}”…`,
          key: "agent.activityReadSection",
          params: { title },
        }),
        "read",
        () => budget.gen,
        async ({ title, offset = 0, maxChars = R.DEFAULT_RANGE_MAX_CHARS }, options, runGen) => {
          const path = R.resolvePathInput(undefined, options);
          const doc = R.requireLoadedDoc(path);
          if (budget.used >= budget.max) {
            return { budgetExceeded: true, note: R.BUDGET_NOTE };
          }

          const outline = R.resolveOutline(doc);
          const index = findSectionIndex(outline, title);
          const range = sectionRange(outline, index, doc.totalPages);
          if (!range) {
            return {
              note:
                outline.length === 0
                  ? "This document has no section headings; read by page range instead."
                  : `No section matches "${title}". Call document_outline for the headings that exist.`,
            };
          }

          // A resolved section is a page range, and a page range already has one
          // correct reader — including vision indexing for pages with no text
          // layer, the scan allowance, and offset continuation.
          const read = await R.readPageRange(
            path,
            doc,
            { start: range.startPage, end: range.endPage, offset, maxChars },
            budget,
            runGen,
            chargeBudget,
          );
          return { section: range.title, ...read };
        },
      ),
  });
}
