import { describe, expect, it } from "vitest";
import { rerank } from "ai";
import type { SearchHit } from "./document-search";
import {
  fuseSearchHits,
  lexicalRerankModel,
  rerankSearchHits,
  type RankableHit,
} from "./search-rerank";

describe("search-rerank", () => {
  it("scores lexical overlap via AI SDK rerank", async () => {
    const { ranking } = await rerank({
      model: lexicalRerankModel,
      documents: ["unrelated text", "quarterly revenue grew strongly"],
      query: "revenue",
      topN: 2,
    });

    expect(ranking[0]?.originalIndex).toBe(1);
    expect(ranking[0]?.score).toBeGreaterThan(ranking[1]?.score ?? 0);
  });

  it("reorders search hits by query relevance", async () => {
    const hits: SearchHit[] = [
      { page: 1, index: 0, snippet: "intro", match: "budget" },
      { page: 2, index: 0, snippet: "budget forecast", match: "budget" },
    ];
    const pageTexts = new Map<number, string>([
      [1, "introduction to the company"],
      [2, "the annual budget forecast for next year"],
    ]);

    const reranked = await rerankSearchHits("budget forecast", hits, pageTexts, 2);
    expect(reranked[0]?.page).toBe(2);
  });
});

describe("fuseSearchHits", () => {
  it("surfaces a semantically-strong but lexically-weak page", () => {
    // Page 3 never mentions the query terms but has a high semantic score; a pure
    // lexical reranker would bury it. RRF must rank it above unrelated pages.
    const hits: RankableHit[] = [
      { page: 1, index: 0, match: "revenue", snippet: "misc", semanticScore: 0.2 },
      { page: 2, index: 0, match: "revenue", snippet: "misc" },
      { page: 3, index: 0, match: "revenue", snippet: "quarterly earnings summary", semanticScore: 0.92 },
    ];
    const pageTexts = new Map<number, string>([
      [1, "table of contents"],
      [2, "appendix and disclaimers"],
      [3, "net earnings rose sharply this quarter"],
    ]);

    const fused = fuseSearchHits("revenue growth", hits, pageTexts, 3);
    expect(fused[0]?.page).toBe(3);
  });

  it("fuses lexical and semantic rank rather than using semantic score alone", () => {
    // Page 1 wins lexically (query terms present); page 2 wins semantically. Both
    // signals contribute, so the strong-lexical page is not discarded.
    const hits: RankableHit[] = [
      { page: 1, index: 0, match: "budget", snippet: "annual budget budget plan", semanticScore: 0.3 },
      { page: 2, index: 0, match: "budget", snippet: "financial outlook", semanticScore: 0.6 },
    ];
    const pageTexts = new Map<number, string>([
      [1, "the annual budget plan and budget breakdown"],
      [2, "our financial outlook for the coming year"],
    ]);

    const fused = fuseSearchHits("budget", hits, pageTexts, 2);
    expect(fused).toHaveLength(2);
    expect(fused.map((h) => h.page).sort()).toEqual([1, 2]);
  });

  it("returns hits unchanged when there is nothing to fuse", () => {
    const single: RankableHit[] = [{ page: 1, index: 0, match: "x", snippet: "x" }];
    expect(fuseSearchHits("x", single, new Map(), 5)).toEqual(single);
  });
});
