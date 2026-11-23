import { tool } from "ai";
import { visionModelAvailable } from "../../settings";
import { z } from "zod";
import { consumePinnedDraftSelection, getActiveReaderSelection } from "../../active-selection";
import { describeFigure, describeFigureOrPage, figuresOnPage, viewRectToPdfRect } from "../../read-figure";
import { getAgentRunAbortSignal } from "../../agent-abort";
import { throwIfAborted } from "../../abort-utils";
import * as R from "../reading";
import type { ReadBudget } from "../reading";

/** The `read_figure` tool. Everything shared with the other five lives in ../reading. */
export function createReadFigureTool(
  budget: ReadBudget,
  chargeBudget: (runGen: number, chars: number) => void,
) {
  return tool({
    description:
      "Inspect a figure, chart or diagram on a page via the vision model (billed). " +
      "Figures are numbered from 1 by size (omit index for largest; pass fullPage=true " +
      "for vector plots/equations on pages that also have a small logo). Pass question for exact values.",
    inputSchema: z.object({
      page: z.number().int().min(1),
      index: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(`Which figure on the page, largest first (default ${R.DEFAULT_FIGURE_INDEX})`),
      fullPage: z
        .boolean()
        .optional()
        .describe("Inspect the full rendered page instead of cropping a single bitmap"),
      question: z
        .string()
        .optional()
        .describe("Specific question or values to extract"),
    }),
    contextSchema: R.docToolContextSchema,
    execute: R.bindToolExecute(
      ({ page }) => ({
        message: `Looking at the figure on page ${page}…`,
        key: "agent.activityFigure",
        params: { page },
      }),
      "index",
      () => budget.gen,
      async ({ page, index = R.DEFAULT_FIGURE_INDEX, fullPage = false, question }, options, runGen) => {
        const path = R.activeDocPath(options);
        const doc = R.requireLoadedDoc(path);
        R.assertPageInBounds(doc, page);
        if (budget.used >= budget.max) {
          return { budgetExceeded: true, note: R.BUDGET_NOTE };
        }

        const figures = figuresOnPage(doc.figures, page);
        // When the user boxed a specific region on `page` (`Alt+drag`), prioritize
        // cropping that exact user-boxed region on default `read_figure({ page })` (30.0).
        const sel = getActiveReaderSelection(path);
        const boxedViewRect =
          !fullPage && index === 1 && sel?.kind === "region" && sel.page === page && sel.pdfRect
            ? sel.pdfRect
            : undefined;
        if (!fullPage && !boxedViewRect && figures.length === 0 && index > 1) {
          return {
            page,
            figureCount: 0,
            note: `Page ${page} has no embedded bitmap figures; omit index to inspect the rendered page.`,
          };
        }
        const candidateFigure = !fullPage && figures.length > 0 ? figures[index - 1] : undefined;
        if (!fullPage && !boxedViewRect && figures.length > 0 && !candidateFigure) {
          return {
            page,
            figureCount: figures.length,
            note: `Page ${page} has ${figures.length} figure(s); index ${index} is out of range.`,
          };
        }
        // Avoid the corner-logo trap: when `index` was defaulted to 1 and the largest
        // bitmap on the page is tiny (`< 56pt` on an edge, e.g. a running header icon
        // on a vector matplotlib/TikZ plot page), inspect the rendered page instead.
        const figure =
          boxedViewRect
            ? undefined
            : candidateFigure &&
                index === 1 &&
                (candidateFigure.rect.width < 56 || candidateFigure.rect.height < 56)
              ? undefined
              : candidateFigure;

        const effectiveIndex = boxedViewRect ? -1 : figure ? index : 0;
        if (R.alreadyDeliveredFigure(budget, path, page, effectiveIndex, question)) {
          return {
            page,
            ...(figure ? { figureIndex: index } : { fullPage: true }),
            figureCount: figures.length,
            description: R.ALREADY_DESCRIBED_NOTE,
            alreadyRead: true,
          };
        }

        if (!(await visionModelAvailable())) {
          return { page, figureCount: figures.length, visionUnavailable: true, note: R.NO_VISION_NOTE };
        }

        if (budget.gen !== runGen || budget.scans >= budget.maxScans) {
          return { page, figureCount: figures.length, scanLimitReached: true, note: R.FIGURE_LIMIT_NOTE };
        }
        budget.scans += 1;

        const signal = getAgentRunAbortSignal();
        throwIfAborted(signal);
        let description: string;
        if (boxedViewRect && doc.kind === "pdf") {
          const pdfRect = await viewRectToPdfRect(path, page, boxedViewRect);
          if (sel?.pinnedForDraft) consumePinnedDraftSelection(path);
          description = await describeFigure(path, page, { page, rect: pdfRect }, signal, question);
        } else if (figure) {
          description = await describeFigure(path, page, figure, signal, question);
        } else {
          description = await describeFigureOrPage(path, doc, page, undefined, question, signal);
        }
        throwIfAborted(signal);
        R.markFigureDelivered(budget, path, page, effectiveIndex, runGen, question);

        const result = {
          page,
          ...(boxedViewRect ? { boxedRegion: true } : figure ? { figureIndex: index } : { fullPage: true }),
          figureCount: figures.length,
          description,
        };
        chargeBudget(runGen, R.estimateTokens(JSON.stringify(result)));
        return result;
      },
    ),
  });
}
