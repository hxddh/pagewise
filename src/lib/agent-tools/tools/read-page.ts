import { tool } from "ai";
import { z } from "zod";
import * as R from "../reading";
import { pageForLabel } from "../../page-labels";
import type { ReadBudget } from "../reading";

/** The `read_pdf_page` tool. Everything shared with the other five lives in ../reading. */
export function createReadPdfPageTool(
  budget: ReadBudget,
  chargeBudget: (runGen: number, chars: number) => void,
) {
  return tool({
      description:
        "Read text from a specific page of a loaded document (1-based page number). " +
        "If the reader cited a number printed on the page rather than a position you " +
        "worked out, pass it as `label` instead — some documents number their front " +
        "matter separately, so the two differ. " +
        "For very long pages the output is capped at maxChars; when truncated=true, call again " +
        "with offset=nextOffset to continue the same page.",
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe("Loaded document path; defaults to the active document"),
        page: z.number().int().min(1),
        label: z
          .string()
          .optional()
          .describe("A page number as PRINTED on the page (e.g. \"iv\", \"A-3\"); overrides page"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Character offset into the page to resume from (a previous nextOffset)"),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(50_000)
          .optional()
          .describe(`Max characters to return (default ${R.DEFAULT_PAGE_MAX_CHARS})`),
      }),
      contextSchema: R.docToolContextSchema,
      execute: R.bindToolExecute(
        (input) => {
          const page = (input as { page?: unknown } | undefined)?.page;
          return typeof page === "number"
            ? {
                message: `Reading page ${page}…`,
                key: "agent.activityReadPage",
                params: { page },
              }
            : { message: "Reading page…", key: "agent.activityReadRange" };
        },
        "read",
        () => budget.gen,
        async (
          { path: inputPath, page: askedPage, label, offset = 0, maxChars = R.DEFAULT_PAGE_MAX_CHARS },
          options,
          runGen,
        ): Promise<R.ReadResultLike> => {
          const path = R.resolvePathInput(inputPath, options);
          const doc = R.requireLoadedDoc(path);
          // A printed number wins when the document prints it exactly once.
          // Resolution is arithmetic the model should not be doing: it has the
          // table nowhere, and a document may restart its numbering per
          // chapter. Unresolvable falls back to the position rather than
          // failing — the model may have passed a label for a document that
          // has none, and reading the page it asked for is the better answer.
          const page = label ? (pageForLabel(doc.pageLabels ?? null, label) ?? askedPage) : askedPage;
          R.assertPageInBounds(doc, page);

          // Already handed over whole in this run. Answered before R.readPageText
          // so the repeat costs neither the page's tokens nor — for a page with
          // no text layer — a second billed vision call.
          if (offset === 0 && R.alreadyDelivered(budget, path, page)) {
            return {
              page,
              text: R.ALREADY_READ_NOTE,
              truncated: false,
              nextOffset: null,
              charCount: 0,
              alreadyRead: true,
            };
          }

          if (budget.used >= budget.max) {
            return {
              page,
              text: "",
              truncated: false,
              nextOffset: null,
              charCount: 0,
              budgetExceeded: true,
              note: R.BUDGET_NOTE,
            };
          }

          const { text, source, indexFailure, scanLimit } = await R.readPageText(
            path,
            page,
            budget,
          );
          if (scanLimit) {
            return {
              page,
              text: "",
              source,
              truncated: false,
              nextOffset: null,
              charCount: 0,
              scanLimitReached: true,
              note: R.SCAN_LIMIT_NOTE,
            };
          }
          // An index FAILURE (missing key / vision error / timeout) is not an
          // empty page — tell the model so it doesn't conclude "no content" or
          // waste steps re-reading (each retry re-triggers a billed vision call).
          if (!text && indexFailure) {
            return {
              page,
              text: "",
              source,
              truncated: false,
              nextOffset: null,
              charCount: 0,
              indexingFailed: true,
              note: `This page could not be indexed (${indexFailure}). Its text is unavailable — do not treat this as an empty page, and don't re-read it without a fix; tell the user indexing failed.`,
            };
          }
          if (text.length > 0 && offset > text.length) {
            return {
              page,
              text: "",
              source,
              truncated: false,
              nextOffset: null,
              charCount: 0,
              note: "Page text changed since the prior read; call read_pdf_page again from the start if needed.",
            };
          }
          const from = Math.min(offset, text.length);
          const room = Math.min(maxChars, budget.max - budget.used);
          const slice = text.slice(from, from + room);
          chargeBudget(runGen, slice.length);

          const consumedEnd = from + slice.length;
          const truncated = consumedEnd < text.length;
          const limitedByBudget = truncated && budget.used >= budget.max;
          // A whole page, read from the start: the next request for it is a
          // repeat. A truncated read is deliberately not recorded.
          if (offset === 0 && !truncated) R.markDelivered(budget, path, page);

          return {
            page,
            ...(R.printedLabel(doc, page) ? { printedAs: R.printedLabel(doc, page) } : {}),
            text: slice,
            source,
            truncated,
            nextOffset: truncated ? consumedEnd : null,
            charCount: slice.length,
            ...(limitedByBudget ? { budgetExceeded: true, note: R.BUDGET_NOTE } : {}),
            ...R.chargedAttachments(doc, path, [page], runGen, chargeBudget),
          };
        },
      ),
  });
}
