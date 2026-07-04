import type { RerankingModelV4 } from "@ai-sdk/provider";
import { rerank } from "ai";
import type { SearchHit } from "./document-search";

function lexicalScore(query: string, text: string): number {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (terms.length === 0) return 0;

  const hay = text.toLowerCase();
  let hits = 0;
  for (const term of terms) {
    let idx = 0;
    while ((idx = hay.indexOf(term, idx)) !== -1) {
      hits += 1;
      idx += term.length;
    }
  }
  return hits / terms.length;
}

/** Local lexical reranker — uses AI SDK `rerank` without an external API. */
export const lexicalRerankModel: RerankingModelV4 = {
  specificationVersion: "v4",
  provider: "pagewise",
  modelId: "lexical-rerank",
  doRerank: async ({ documents, query, topN }) => {
    const values =
      documents.type === "text"
        ? documents.values
        : documents.values.map((doc) => JSON.stringify(doc));

    const ranking = values
      .map((doc, index) => ({
        index,
        relevanceScore: lexicalScore(query, doc) + 0.0001 * (values.length - index),
      }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore);

    return {
      ranking: topN != null ? ranking.slice(0, topN) : ranking,
      warnings: [],
    };
  },
};

export async function rerankSearchHits(
  query: string,
  hits: SearchHit[],
  pageTexts: Map<number, string>,
  limit = 30,
): Promise<SearchHit[]> {
  if (hits.length <= 1) return hits;

  const documents = hits.map((hit) => {
    const full = pageTexts.get(hit.page) ?? "";
    return `${hit.snippet}\n${full.slice(0, 2000)}`.trim();
  });

  const { ranking } = await rerank({
    model: lexicalRerankModel,
    documents,
    query,
    topN: limit,
  });

  return ranking
    .map((entry) => hits[entry.originalIndex])
    .filter((hit): hit is SearchHit => hit != null);
}
