import { tool } from "ai";
import { z } from "zod";
import { docCache } from "../../doc-cache";
import { MIN_INDEX_CHARS } from "../../page-text-merge";
import { pagesWithFigures } from "../../read-figure";
import { pagesWithLinks } from "../../page-links";
import { getMarks, pagesWithMarks } from "../../mark-store";
import * as R from "../reading";
import type { ReadBudget } from "../reading";

/** The `document_outline` tool. Everything shared with the other five lives in ../reading. */
export function createDocumentOutlineTool(
  budget: ReadBudget,
  chargeBudget: (runGen: number, chars: number) => void,
) {
  return tool({
      description:
        "Document overview: the bookmark/section tree (title → page) when there is " +
        "one, the total length, and which pages are densest, unreadable, or carry " +
        "figures, tables, links or the reader's marks. Jump to a section with it, " +
        "or plan reads of a large document. pageStats adds per-page character " +
        "counts, previews text per page — both are large; the summary is usually " +
        "enough.",
      inputSchema: z.object({
        previews: z
          .boolean()
          .optional()
          .describe(`A short text preview per page (first ${R.MAX_OUTLINE_PAGE_STATS} pages).`),
        pageStats: z
          .boolean()
          .optional()
          .describe("Every page's character count — large; the summary already has the totals."),
      }),
      contextSchema: R.docToolContextSchema,
      execute: R.bindToolExecute(
        () => ({ message: "Scanning document…", key: "agent.activityIndex" }),
        "tool",
        () => budget.gen,
        async ({ previews = false, pageStats = false }, options, runGen) => {
          const path = R.activeDocPath(options);
          const doc = R.requireLoadedDoc(path);
          if (budget.used >= budget.max) {
            return { budgetExceeded: true, note: R.BUDGET_NOTE };
          }
          const pages = docCache.getPages(path);
          // Previews are the expensive half of this result: 200 of them measures
          // 19,693 characters — about 4,900 tokens for one call, which the loop
          // then resends on every later step. (An earlier version of this note
          // said 40,000 characters and ten thousand tokens; it was an estimate,
          // and it was double.)
          const allStats = pages.map((p) => ({
            page: p.page,
            chars: p.text.length,
            ...(previews ? { preview: p.text.trim().slice(0, R.OUTLINE_PREVIEW_CHARS) } : {}),
          }));
          const totalChars = allStats.reduce((sum, p) => sum + p.chars, 0);
          const unindexedPages = pages
            .filter((p) => p.text.trim().length < MIN_INDEX_CHARS)
            .map((p) => p.page);
          // A section tree so the agent can jump by section ("summarize chapter
          // 3") instead of scanning per-page previews. Authored bookmarks are
          // authoritative when the PDF carries them; most do not, and for those
          // the headings recovered from the page text are the only structure
          // there is. Image documents have neither.
          const bookmarks = R.resolveOutline(doc);
          const figurePages = pagesWithFigures(doc.figures);
          const linkPages = pagesWithLinks(doc.links);
          const markPages = pagesWithMarks(path);
          const outlineMarks = R.outlineMarkList(path);
          // Previews live on the per-page entries, so asking for them implies
          // the list they sit on.
          const includeStats = pageStats || previews;
          const statsOmitted = includeStats
            ? Math.max(0, allStats.length - R.MAX_OUTLINE_PAGE_STATS)
            : 0;
          const result = {
            totalPages: doc.totalPages || pages.length,
            totalChars,
            suggestedChunkSize: R.DEFAULT_RANGE_MAX_CHARS,
            needsChunking: totalChars > R.DEFAULT_RANGE_MAX_CHARS,
            /*
             * The per-page character counts used to be sent in full: 200 pages
             * of {page, chars} measures 5,093 characters, about 1,273 tokens on
             * every survey, and there is nothing a model does with "page 87 has
             * 3,421 characters". What planning needs is already above —
             * totalChars, needsChunking, suggestedChunkSize — and the readers
             * handle chunking themselves through truncated/nextStart/nextOffset.
             *
             * What survives is the part that points somewhere: the R.densest
             * pages, which is where a dense document's substance tends to be.
             * The full list is still one flag away for anything that needs it.
             */
            densestPages: R.densest(allStats),
            ...(includeStats
              ? {
                  pages:
                    statsOmitted > 0 ? allStats.slice(0, R.MAX_OUTLINE_PAGE_STATS) : allStats,
                }
              : {}),
            // The tree is now in the transcript. Saying so here costs one line
            // in the messages; the alternative — withdrawing the tool for the
            // rest of the run — changes the tool block and throws away the
            // cached prefix on every remaining step.
            surveyNote: R.ONCE_SURVEYED_NOTE,
            ...(statsOmitted > 0
              ? {
                  pageStatsOmitted: statsOmitted,
                  pageStatsNote:
                    `Per-page stats cover the first ${R.MAX_OUTLINE_PAGE_STATS} of ` +
                    `${allStats.length} pages; use search_in_document or read_pdf_range ` +
                    "to work with later pages.",
                }
              : {}),
            ...(bookmarks.length > 0 ? { bookmarks } : {}),
            // Tables must be read whole — a reflowed table merges neighbouring
            // numbers into one wrong number.
            ...(doc.tablePages?.length ? { pagesWithTables: R.compressPageRanges(doc.tablePages) } : {}),
            // Notes somebody already wrote on this document. Carried in the
            // survey's OUTPUT, which costs nothing in the cached prefix — only
            // a tool's description and input schema sit there. Someone has
            // already said which sentence matters and why, and an answer given
            // without that is an answer given with less than the reader has.
            ...R.documentNotes(doc),
            // Without this, read_figure could only be reached by guessing that
            // a page has a figure.
            ...(figurePages.length > 0
              ? {
                  pagesWithFigures: R.compressPageRanges(figurePages),
                }
              : {}),
            // Hyperlink destinations live only in the PDF's annotations, never
            // in the page text — reading a page is the only way to see them.
            ...(linkPages.length > 0
              ? {
                  pagesWithLinks: R.compressPageRanges(linkPages),
                }
              : {}),
            // What the reader marked says what they care about; it is nowhere in
            // the page text. Carried here in full rather than as page numbers
            // alone: "summarize what I marked" otherwise costs one page read
            // per marked page for text already held in memory.
            ...(markPages.length > 0
              ? {
                  pagesWithMarks: R.compressPageRanges(markPages),
                  ...(outlineMarks
                    ? { marks: outlineMarks }
                    : { markCount: getMarks(path).length }),
                }
              : {}),
            ...(unindexedPages.length > 0
              ? {
                  unindexedPageCount: unindexedPages.length,
                  unindexedPages: R.compressPageRanges(unindexedPages),
                  unindexedNote: R.UNINDEXED_NOTE,
                }
              : {}),
          };
          // Outline output lands in context like any read — count it.
          chargeBudget(runGen, R.estimateTokens(JSON.stringify(result)));
          return result;
        },
      ),
  });
}
