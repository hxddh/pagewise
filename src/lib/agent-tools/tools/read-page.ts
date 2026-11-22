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
            const fetched = await Promise.all(
              distinctPages.map(async (p) => {
                if (R.alreadyDelivered(budget, path, p)) {
                  return { page: p, text: R.ALREADY_READ_NOTE, already: true, source: "cache" as const };
                }
                const r = await R.readPageText(path, p, budget, runGen);
                return { ...r, already: false };
              }),
            );
            const blocks: string[] = [];
            const deliveredNow: number[] = [];
            let totalChars = 0;
            let hitBudget = false;
            const totalCap = Math.min(50_000, Math.max(maxChars, distinctPages.length * R.DEFAULT_PAGE_MAX_CHARS));
            for (const item of fetched) {
              const pLabel = R.printedLabel(doc, item.page);
              const hdr = pLabel
                ? `--- Page ${item.page} (printed ${pLabel}) ---`
                : `--- Page ${item.page} ---`;
              if (item.already) {
                blocks.push(`${hdr}\n${item.text}`);
                continue;
              }
              const free = R.isFreeReread(budget, path, item.page);
              const remainingCap = Math.max(0, totalCap - totalChars);
              if ((!free && budget.used >= budget.max) || remainingCap === 0) {
                hitBudget = true;
                break;
              }
              const room = free
                ? Math.min(maxChars, remainingCap)
                : Math.min(maxChars, remainingCap, R.affordableChars(item.text, budget));
              const slice = item.text.slice(0, room);
              if (!free) chargeBudget(runGen, R.estimateTokens(slice));
              totalChars += slice.length;
              if (slice.length === item.text.length && item.text.length > 0) {
                R.markDelivered(budget, path, item.page, runGen);
              }
              deliveredNow.push(item.page);
              blocks.push(`${hdr}\n${slice || "(empty page)"}`);
            }
            return {
              page: distinctPages[0],
              pages: deliveredNow.length > 0 ? deliveredNow : distinctPages,
              text: blocks.join("\n\n"),
              truncated: hitBudget,
              nextOffset: null,
              charCount: totalChars,
              ...(hitBudget ? { budgetExceeded: budget.used >= budget.max, note: R.BUDGET_NOTE } : {}),
              ...R.chargedAttachments(doc, path, deliveredNow, runGen, chargeBudget),
            } as R.ReadResultLike;
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
