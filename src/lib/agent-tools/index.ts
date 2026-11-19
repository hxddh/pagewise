import { newReadBudget, type ReadBudget } from "./reading";
import { compactToolSchemas } from "./compact-schema";
import { createDocumentOutlineTool } from "./tools/document-outline";
import { createReadPdfPageTool } from "./tools/read-page";
import { createReadPdfRangeTool } from "./tools/read-range";
import { createReadSectionTool } from "./tools/read-section";
import { createReadFigureTool } from "./tools/read-figure";
import { createSearchInDocumentTool } from "./tools/search";
import { createNoteFindingTool } from "./tools/note-finding";
import { createReviseFindingTool } from "./tools/revise-finding";

export {
  newReadBudget,
  compressPageRanges,
  DEFAULT_PAGE_MAX_CHARS,
  DEFAULT_RANGE_MAX_CHARS,
  DEFAULT_SEARCH_HITS,
  DEFAULT_FIGURE_INDEX,
  MAX_FREE_REREADS,
  RUN_TOKEN_BUDGET,
  estimateTokens,
  type ReadBudget,
} from "./reading";

export function createDocumentTools(
  budget: ReadBudget = newReadBudget(),
  options?: { tokenBudget?: number },
) {
  if (options?.tokenBudget !== undefined) {
    budget.max = options.tokenBudget;
  }
  const chargeBudget = (runGen: number, chars: number): void => {
    if (budget.gen === runGen) budget.used += chars;
  };

  return compactToolSchemas({
    document_outline: createDocumentOutlineTool(budget, chargeBudget),
    read_pdf_page: createReadPdfPageTool(budget, chargeBudget),
    read_pdf_range: createReadPdfRangeTool(budget, chargeBudget),
    read_section: createReadSectionTool(budget, chargeBudget),
    read_figure: createReadFigureTool(budget, chargeBudget),
    search_in_document: createSearchInDocumentTool(budget, chargeBudget),
    note_finding: createNoteFindingTool(),
    revise_finding: createReviseFindingTool(),
  });
}

export const createAgentTools = createDocumentTools;
