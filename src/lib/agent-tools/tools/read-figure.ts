import { tool } from "ai";
import { visionModelAvailable } from "../../settings";
import { z } from "zod";
import { describeFigure, describeFigureOrPage, figuresOnPage } from "../../read-figure";
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
      "Figures are numbered from 1 by size (omit index for largest; falls back to " +
      "full page for vector plots). Pass question for exact axis/series values.",
    inputSchema: z.object({
      page: z.number().int().min(1),
      index: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(`Which figure on the page, largest first (default ${R.DEFAULT_FIGURE_INDEX})`),
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
      async ({ page, index = R.DEFAULT_FIGURE_INDEX, question }, options, runGen) => {
        const path = R.activeDocPath(options);
        const doc = R.requireLoadedDoc(path);
        R.assertPageInBounds(doc, page);
        if (budget.used >= budget.max) {
          return { budgetExceeded: true, note: R.BUDGET_NOTE };
        }

        const figures = figuresOnPage(doc.figures, page);
        if (figures.length === 0 && index > 1) {
          return {
            page,
            figureCount: 0,
            note: `Page ${page} has no embedded bitmap figures; omit index to inspect the rendered page.`,
          };
        }
        const figure = figures.length > 0 ? figures[index - 1] : undefined;
        if (figures.length > 0 && !figure) {
          return {
            page,
            figureCount: figures.length,
            note: `Page ${page} has ${figures.length} figure(s); index ${index} is out of range.`,
          };
        }

        const effectiveIndex = figure ? index : 0;
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

        if (budget.scans >= budget.maxScans) {
          return { page, figureCount: figures.length, scanLimitReached: true, note: R.FIGURE_LIMIT_NOTE };
        }
        budget.scans += 1;

        const signal = getAgentRunAbortSignal();
        throwIfAborted(signal);
        const description = figure
          ? await describeFigure(path, page, figure, signal, question)
          : await describeFigureOrPage(path, doc, page, undefined, question, signal);
        throwIfAborted(signal);
        R.markFigureDelivered(budget, path, page, effectiveIndex, runGen, question);

        const result = {
          page,
          ...(figure ? { figureIndex: index } : { fullPage: true }),
          figureCount: figures.length,
          description,
        };
        chargeBudget(runGen, R.estimateTokens(JSON.stringify(result)));
        return result;
      },
    ),
  });
}
