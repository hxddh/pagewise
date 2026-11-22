import { tool } from "ai";
import { z } from "zod";
import { docCache } from "../../doc-cache";
import { waitForDocumentExtraction } from "../../load-document";
import { MIN_INDEX_CHARS } from "../../page-text-merge";
import { searchForAgent, type AgentSearchHit } from "../../../document/search";
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
        "Search for keywords/phrases in the document (and PDF annotations). Pass `query` or " +
        `up to 5 \`queries\` at once. Returns up to maxResults hits (${R.DEFAULT_SEARCH_HITS} default); ` +
        "truncated=true means more exist.",
      inputSchema: z.object({
        query: z.string().min(1).optional(),
        queries: z
          .array(z.string().min(1))
          .min(1)
          .max(5)
          .optional()
          .describe("Up to 5 synonyms or terms to search in one call"),
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
        async ({ query, queries, maxResults = R.DEFAULT_SEARCH_HITS }, options, runGen) => {
          const path = R.activeDocPath(options);
          await waitForDocumentExtraction(path);
          const doc = R.requireLoadedDoc(path);
          if (budget.used >= budget.max) {
            return { hits: [], truncated: false, budgetExceeded: true, note: R.BUDGET_NOTE };
          }
          const terms = [
            ...(query ? [query] : []),
            ...(queries ?? []),
          ]
            .map((q) => q.trim().slice(0, 400))
            .filter(Boolean)
            .slice(0, 5);
          if (terms.length === 0) {
            return { hits: [], truncated: false };
          }
          const pages = docCache.getPages(path);
          const merged: AgentSearchHit[] = [];
          const seenAcrossTerms = new Set<string>();
          for (const term of terms) {
            const termHits = searchForAgent(pages, term, maxResults + 1);
            for (const h of termHits) {
              const key = `${h.page}:${h.snippet}`;
              if (terms.length > 1 && seenAcrossTerms.has(key)) continue;
              merged.push(h);
            }
            for (const h of termHits) {
              seenAcrossTerms.add(`${h.page}:${h.snippet}`);
            }
            // Also search third-party PDF annotations / sticky notes / form values (29.0).
            const lower = term.toLowerCase();
            for (const a of doc.annotations ?? []) {
              const hay = `${a.quoted ?? ""} ${a.contents ?? ""}`.trim();
              if (!hay || !hay.toLowerCase().includes(lower)) continue;
              const snippet = `[${a.subtype}${a.author ? ` · ${a.author}` : ""}] ${hay}`.slice(0, 180);
              const key = `${a.page}:annot:${snippet}`;
              if (seenAcrossTerms.has(key)) continue;
              seenAcrossTerms.add(key);
              merged.push({ page: a.page, snippet });
            }
          }
          const truncated = merged.length > maxResults;
          const sliced = truncated ? merged.slice(0, maxResults) : merged;
          const hits = doc.pageLabels
            ? sliced.map((h) => {
                const printedAs = R.printedLabel(doc, h.page);
                return printedAs ? { ...h, printedAs } : h;
              })
            : sliced;
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
          chargeBudget(runGen, R.estimateTokens(JSON.stringify(result)));
          return result;
        },
      ),
  });
}
