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
        "Read a section by its heading from document_outline. When truncated=true, " +
        "continue with start=nextStart and offset=nextOffset. Fall back to " +
        "read_pdf_range if recovered heading boundaries look approximate.",
      inputSchema: z.object({
        title: z.string().min(1).describe("Heading text, as document_outline reported it"),
        start: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Page to resume from (a nextStart)"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Character offset to resume from (a nextOffset)"),
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
        async ({ title, start, offset = 0, maxChars = R.DEFAULT_RANGE_MAX_CHARS }, options, runGen) => {
          const path = R.activeDocPath(options);
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
          const resumeStart =
            start !== undefined
              ? Math.max(range.startPage, Math.min(range.endPage, start))
              : range.startPage;
          const read = await R.readPageRange(
            path,
            doc,
            { start: resumeStart, end: range.endPage, offset, maxChars },
            budget,
            runGen,
            chargeBudget,
          );
          return { section: range.title, ...read };
        },
      ),
  });
}
