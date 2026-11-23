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
        "Read text from one page (`page`) or up to 8 non-contiguous pages (`pages`, e.g. search hits) " +
        "of the active document (1-based). Pass `label` if citing a printed page label (e.g. \"iv\"). " +
        "Capped at maxChars; when truncated=true, resume with offset=nextOffset.",
      inputSchema: z.object({
        page: z.number().int().min(1).optional(),
        pages: z
          .array(z.number().int().min(1))
          .min(1)
          .max(8)
          .optional()
          .describe("Up to 8 non-contiguous pages to read in one call"),
        label: z
          .string()
          .optional()
          .describe("Printed page label (e.g. \"iv\", \"A-3\"); overrides page"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Character offset to resume from (a nextOffset)"),
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
          const inp = input as { page?: unknown; pages?: unknown } | undefined;
          const page = inp?.page;
          if (Array.isArray(inp?.pages) && inp.pages.length > 1) {
            return { message: `Reading ${inp.pages.length} pages…`, key: "agent.activityReadRange" };
          }
          const single =
            typeof page === "number"
              ? page
              : Array.isArray(inp?.pages) && typeof inp.pages[0] === "number"
                ? inp.pages[0]
                : undefined;
          return typeof single === "number"
            ? {
                message: `Reading page ${single}…`,
                key: "agent.activityReadPage",
                params: { page: single },
              }
            : { message: "Reading page…", key: "agent.activityReadRange" };
        },
        "read",
        () => budget.gen,
        async (
          { page: rawPage, pages: rawPages, label, offset = 0, maxChars = R.DEFAULT_PAGE_MAX_CHARS },
          options,
          runGen,
        ): Promise<R.ReadResultLike> => {
          const path = R.activeDocPath(options);
          const doc = R.requireLoadedDoc(path);

          // Multi-page batch read (`pages: [3, 11, 19]`): read non-contiguous pages in parallel in 1 step!
          const distinctPages = rawPages
            ? [...new Set(rawPages.filter((p) => Number.isInteger(p) && p >= 1))].slice(0, 8)
            : [];
          if (distinctPages.length > 1) {
            for (const p of distinctPages) R.assertPageInBounds(doc, p);
            if (budget.used >= budget.max) {
              return {
                page: distinctPages[0],
                text: "",
                truncated: false,
                nextOffset: null,
                charCount: 0,
                budgetExceeded: true,
                note: R.BUDGET_NOTE,
              };
            }
            const blocks: string[] = [];
            const deliveredNow: number[] = [];
            const truncatedPages: Array<{ page: number; nextOffset: number }> = [];
            const omittedPages: number[] = [];
            const failedPages: number[] = [];
            const failureReasons: string[] = [];
            const unscannedPages: number[] = [];
            let totalChars = 0;
            let hitBudget = false;
            let scanLimitReached = false;
            let sawOcrSource = false;
            const totalCap = Math.min(50_000, Math.max(maxChars, distinctPages.length * R.DEFAULT_PAGE_MAX_CHARS));

            for (let idx = 0; idx < distinctPages.length; idx += 1) {
              const p = distinctPages[idx]!;
              const pageOffset = idx === 0 && offset > 0 ? offset : 0;
              const pLabel = R.printedLabel(doc, p);
              const hdr = pLabel
                ? `--- Page ${p} (printed ${pLabel}) ---`
                : `--- Page ${p} ---`;
              if (pageOffset === 0 && R.alreadyDelivered(budget, path, p)) {
                blocks.push(`${hdr}\n${R.ALREADY_READ_NOTE}`);
                continue;
              }
              const free = pageOffset === 0 && R.isFreeReread(budget, path, p);
              const remainingCap = Math.max(0, totalCap - totalChars);
              if ((!free && budget.used >= budget.max) || remainingCap === 0) {
                if (!free && budget.used >= budget.max) hitBudget = true;
                omittedPages.push(
                  ...distinctPages.slice(idx).filter((rest) => !R.alreadyDelivered(budget, path, rest)),
                );
                break;
              }

              const item = await R.readPageText(path, p, budget, runGen);
              if (item.source === "ocr") sawOcrSource = true;
              if (item.scanLimit) {
                scanLimitReached = true;
                unscannedPages.push(p);
                blocks.push(`${hdr}\n${R.SCAN_LIMIT_NOTE}`);
                continue;
              }
              if (!item.text && item.indexFailure) {
                failedPages.push(p);
                if (!failureReasons.includes(item.indexFailure)) {
                  failureReasons.push(item.indexFailure);
                }
                blocks.push(`${hdr}\n${R.INDEX_FAILED_MARK}`);
                continue;
              }
              if (item.text.length === 0) {
                R.markDelivered(budget, path, p, runGen);
                deliveredNow.push(p);
                blocks.push(`${hdr}\n${R.EMPTY_PAGE_NOTE}`);
                continue;
              }

              const from = Math.min(pageOffset, item.text.length);
              const availableText = item.text.slice(from);
              const budgetRoom = free ? remainingCap : R.affordableChars(availableText, budget);
              const room = Math.min(maxChars, remainingCap, budgetRoom);
              if (room <= 0) {
                if (!free) hitBudget = true;
                omittedPages.push(
                  ...distinctPages.slice(idx).filter((rest) => !R.alreadyDelivered(budget, path, rest)),
                );
                break;
              }
              const slice = availableText.slice(0, room);
              const consumedEnd = from + slice.length;
              if (!free) chargeBudget(runGen, R.estimateTokens(slice));
              totalChars += slice.length;
              deliveredNow.push(p);

              if (consumedEnd < item.text.length) {
                truncatedPages.push({ page: p, nextOffset: consumedEnd });
                if (!free && budgetRoom < Math.min(maxChars, remainingCap)) hitBudget = true;
                blocks.push(
                  `${hdr}\n${slice}\n[… page ${p} truncated at offset ${consumedEnd} of ${item.text.length}; resume with read_pdf_page({ page: ${p}, offset: ${consumedEnd} })]`,
                );
              } else {
                if (from === 0) R.markDelivered(budget, path, p, runGen);
                blocks.push(`${hdr}\n${slice}`);
              }
            }

            const batchTruncated =
              hitBudget || truncatedPages.length > 0 || omittedPages.length > 0;
            const firstTruncated = truncatedPages[0];
            const nextStart = firstTruncated?.page ?? omittedPages[0] ?? null;
            const nextOffset = firstTruncated
              ? firstTruncated.nextOffset
              : omittedPages.length > 0
                ? 0
                : null;
            const notes: string[] = [];
            if (hitBudget) notes.push(R.BUDGET_NOTE);
            if (scanLimitReached) notes.push(R.SCAN_LIMIT_NOTE);
            if (sawOcrSource) notes.push(R.OCR_TEXT_NOTE);
            if (failedPages.length > 0) {
              notes.push(
                `Pages ${R.compressPageRanges(failedPages)} could not be indexed (${failureReasons.join("; ")}) — do not treat them as empty pages.`,
              );
            }

            return {
              page: distinctPages[0],
              pages: deliveredNow.length > 0 ? deliveredNow : distinctPages,
              text: blocks.join("\n\n"),
              truncated: batchTruncated,
              nextStart,
              nextOffset,
              charCount: totalChars,
              ...(truncatedPages.length > 0 ? { truncatedPages } : {}),
              ...(omittedPages.length > 0 ? { omittedPages } : {}),
              ...(hitBudget ? { budgetExceeded: budget.used >= budget.max } : {}),
              ...(scanLimitReached
                ? {
                    scanLimitReached: true,
                    unscannedPages: R.compressPageRanges(unscannedPages),
                  }
                : {}),
              ...(failedPages.length > 0
                ? {
                    indexingFailed: true,
                    indexingFailedPages: R.compressPageRanges(failedPages),
                    indexingFailedReasons: failureReasons,
                  }
                : {}),
              ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
              ...R.chargedAttachments(doc, path, deliveredNow, runGen, chargeBudget),
            };
          }

          const askedPage = rawPage ?? distinctPages[0] ?? 1;
          const resolvedFromLabel = label ? pageForLabel(doc.pageLabels ?? null, label) : null;
          const page = resolvedFromLabel ?? askedPage;
          const labelUnmatched = Boolean(label && resolvedFromLabel === null);
          R.assertPageInBounds(doc, page);

          if (offset === 0 && R.alreadyDelivered(budget, path, page)) {
            return {
              page,
              ...(R.printedLabel(doc, page) ? { printedAs: R.printedLabel(doc, page) } : {}),
              text: R.ALREADY_READ_NOTE,
              truncated: false,
              nextOffset: null,
              charCount: 0,
              alreadyRead: true,
            };
          }

          const freeReread = offset === 0 && R.isFreeReread(budget, path, page);
          if (!freeReread && budget.used >= budget.max) {
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
            runGen,
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
          const room = freeReread
            ? maxChars
            : Math.min(maxChars, R.affordableChars(text.slice(from), budget));
          const slice = text.slice(from, from + room);
          if (!freeReread) chargeBudget(runGen, R.estimateTokens(slice));

          const consumedEnd = from + slice.length;
          const truncated = consumedEnd < text.length;
          const limitedByBudget = !freeReread && truncated && budget.used >= budget.max;
          if (offset === 0 && !truncated) R.markDelivered(budget, path, page, runGen);

          return {
            page,
            ...(R.printedLabel(doc, page) ? { printedAs: R.printedLabel(doc, page) } : {}),
            text: slice,
            source,
            truncated,
            nextOffset: truncated ? consumedEnd : null,
            charCount: slice.length,
            ...(limitedByBudget
              ? { budgetExceeded: true, note: R.BUDGET_NOTE }
              : text.length === 0
                ? { note: R.EMPTY_PAGE_NOTE }
                : source === "ocr"
                  ? { note: R.OCR_TEXT_NOTE }
                  : labelUnmatched
                    ? { note: `Label "${label}" was not found; showing sheet page ${page}.` }
                    : {}),
            ...R.chargedAttachments(doc, path, [page], runGen, chargeBudget),
          };
        },
      ),
  });
}
