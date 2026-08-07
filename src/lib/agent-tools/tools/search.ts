import { tool } from "ai";
import { z } from "zod";
import { docCache } from "../../doc-cache";
import { MIN_INDEX_CHARS } from "../../page-text-merge";
import { searchInDocument } from "../../../document/search";
import { formatSearchPreview } from "../../search-preview";
import { emitAgentProgress } from "../../agent-progress";
import * as R from "../reading";
import type { ReadBudget } from "../reading";

/** The `search_in_document` tool. Everything shared with the other five lives in ../reading. */
export function createSearchInDocumentTool(
  budget: ReadBudget,
  chargeBudget: (runGen: number, chars: number) => void,
) {
  return tool({
      description:
        "Search for a keyword or phrase in the active document. Returns up to " +
        `maxResults hits (page + snippet), ${R.DEFAULT_SEARCH_HITS} by default; ` +
        "truncated=true means more exist — raise maxResults when you need the long list.",
      inputSchema: z.object({
        query: z.string().min(1),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(`Max hits to return (default ${R.DEFAULT_SEARCH_HITS})`),
      }),
      contextSchema: R.docToolContextSchema,
      execute: R.bindToolExecute(
        () => ({ message: "Searching document…", key: "agent.activitySearch" }),
        "search",
        () => budget.gen,
        async ({ query, maxResults = R.DEFAULT_SEARCH_HITS }, options, runGen) => {
          const path = R.resolvePathInput(undefined, options);
          R.requireLoadedDoc(path);
          if (budget.used >= budget.max) {
            return { hits: [], truncated: false, budgetExceeded: true, note: R.BUDGET_NOTE };
          }
          const pages = docCache.getPages(path);
          // Silently bound a degenerate query instead of failing the call —
          // snippets embed the match, so a huge query inflates every hit.
          const boundedQuery = query.length > 400 ? query.slice(0, 400) : query;
          // Probe one hit past the cap so truncated distinguishes "exactly
          // maxResults matches" from "more matches exist".
          const raw = searchInDocument(pages, boundedQuery, maxResults + 1);
          const truncated = raw.length > maxResults;
          const hits = truncated ? raw.slice(0, maxResults) : raw;
          const preview = formatSearchPreview(hits);
          if (preview) {
            emitAgentProgress(preview.message, "search", {
              key: "agent.activitySearchMatches",
              params: { count: preview.pages, preview: preview.snippets },
            });
          }
          // Signal pages search CANNOT match: image/scan pages with little or no
          // extracted text aren't in the search index, so "no hits" there is not
          // evidence the term is absent. The model often searches before reading,
          // so surface this here (not just in document_outline).
          const unindexedPages = pages
            .filter((p) => p.text.trim().length < MIN_INDEX_CHARS)
            .map((p) => p.page);
          const result = {
            hits,
            truncated,
            ...(unindexedPages.length > 0
              ? {
                  unindexedPageCount: unindexedPages.length,
                  unindexedPages: R.compressPageRanges(unindexedPages),
                  unindexedNote: R.UNINDEXED_NOTE,
                }
              : {}),
          };
          // Search output lands in context like any read — count it.
          chargeBudget(runGen, JSON.stringify(result).length);
          return result;
        },
      ),
  });
}
