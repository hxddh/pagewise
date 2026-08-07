import type { ReadBudget } from "./reading";
import { createDocumentOutlineTool } from "./tools/document-outline";
import { createReadPdfPageTool } from "./tools/read-page";
import { createReadPdfRangeTool } from "./tools/read-range";
import { createReadSectionTool } from "./tools/read-section";
import { createReadFigureTool } from "./tools/read-figure";
import { createSearchInDocumentTool } from "./tools/search";

export {
  newReadBudget,
  compressPageRanges,
  DEFAULT_PAGE_MAX_CHARS,
  DEFAULT_RANGE_MAX_CHARS,
  DEFAULT_SEARCH_HITS,
  DEFAULT_FIGURE_INDEX,
  RUN_CHAR_BUDGET,
  type ReadBudget,
} from "./reading";

/**
 * The six document tools.
 *
 * One file per tool, over a shared reading layer. The alternative — which this
 * replaces — was 1,106 lines in which two readers sat two hundred lines apart
 * and disagreed about what a page ships.
 */
export function createDocumentTools(budget: ReadBudget) {
  // Charge chars to the run's budget — unless the charging tool belongs to an
  // earlier aborted run (stale generation), so it can't drain the new run.
  const chargeBudget = (runGen: number, chars: number): void => {
    if (budget.gen === runGen) budget.used += chars;
  };

  return {
    document_outline: createDocumentOutlineTool(budget, chargeBudget),
    read_pdf_page: createReadPdfPageTool(budget, chargeBudget),
    read_pdf_range: createReadPdfRangeTool(budget, chargeBudget),
    read_section: createReadSectionTool(budget, chargeBudget),
    read_figure: createReadFigureTool(budget, chargeBudget),
    search_in_document: createSearchInDocumentTool(budget, chargeBudget),
  };
}
