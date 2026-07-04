import { describe, expect, it } from "vitest";
import { rerank } from "ai";
import type { SearchHit } from "./document-search";
import { lexicalRerankModel, rerankSearchHits } from "./search-rerank";

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
