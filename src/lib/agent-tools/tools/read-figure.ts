import { tool } from "ai";
import { z } from "zod";
import { describeFigure, figuresOnPage } from "../../read-figure";
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
        "Look at a figure, chart or diagram on a page and describe it. Figures are " +
        "numbered from 1 in order of size on that page; omit index for the largest. " +
        "Use this when a page's text refers to something the text alone does not " +
        "convey. Each call sends one image to the vision model and is billed.",
      inputSchema: z.object({
        page: z.number().int().min(1),
        index: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`Which figure on the page, largest first (default ${R.DEFAULT_FIGURE_INDEX})`),
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
        async ({ page, index = R.DEFAULT_FIGURE_INDEX }, options, runGen) => {
          const path = R.resolvePathInput(undefined, options);
          const doc = R.requireLoadedDoc(path);
          R.assertPageInBounds(doc, page);
          if (budget.used >= budget.max) {
            return { budgetExceeded: true, note: R.BUDGET_NOTE };
          }

          const figures = figuresOnPage(doc.figures, page);
          if (figures.length === 0) {
            return {
              page,
              figureCount: 0,
              note: "This page has no embedded figure to look at. Its content is in the page text.",
            };
          }
          const figure = figures[index - 1];
          if (!figure) {
            return {
              page,
              figureCount: figures.length,
              note: `Page ${page} has ${figures.length} figure(s); index ${index} is out of range.`,
            };
          }

          // A figure costs a billed vision call, so it draws on the same
          // per-question allowance as scanning an unreadable page.
          if (budget.scans >= budget.maxScans) {
            return { page, scanLimitReached: true, note: R.SCAN_LIMIT_NOTE };
          }
          budget.scans += 1;

          const signal = getAgentRunAbortSignal();
          throwIfAborted(signal);
          const description = await describeFigure(path, page, figure, signal);
          throwIfAborted(signal);

          const result = { page, figureIndex: index, figureCount: figures.length, description };
          chargeBudget(runGen, JSON.stringify(result).length);
          return result;
        },
      ),
  });
}
