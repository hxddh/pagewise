import { tool } from "ai";
import { z } from "zod";
import * as R from "../reading";
import type { ReadBudget } from "../reading";

/** The `read_pdf_range` tool. Everything shared with the other five lives in ../reading. */
export function createReadPdfRangeTool(
  budget: ReadBudget,
  chargeBudget: (runGen: number, chars: number) => void,
) {
  return tool({
      description:
        "Read text from a page range (inclusive, 1-based). " +
        `Use maxChars (default ${R.DEFAULT_RANGE_MAX_CHARS}) and continue when truncated=true: call again ` +
        "with start=nextStart, and offset=nextOffset when non-null (the page has more text). " +
        "truncated=false (nextStart=null) means the range is fully read.",
      inputSchema: z.object({
        start: z.number().int().min(1),
        end: z.number().int().min(1),
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
        () => ({ message: "Reading pages…", key: "agent.activityReadRange" }),
        "read",
        () => budget.gen,
        async ({
          start,
          end,
          offset = 0,
          maxChars = R.DEFAULT_RANGE_MAX_CHARS,
        }, options, runGen) => {
          const path = R.activeDocPath(options);
          const doc = R.requireLoadedDoc(path);
          if (start > end) {
            throw new Error(
              `invalid page range: start (${start}) cannot be greater than end (${end}).`,
            );
          }
          if (doc.totalPages > 0 && start > doc.totalPages) {
            throw new Error(
              `start page ${start} is out of range: "${doc.name}" has ${doc.totalPages} page(s).`,
            );
          }
          return R.readPageRange(
            path,
            doc,
            { start, end, offset, maxChars },
            budget,
            runGen,
            chargeBudget,
          );
        },
      ),
  });
}
