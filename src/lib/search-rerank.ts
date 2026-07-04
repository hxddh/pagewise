import type { RerankingModelV4 } from "@ai-sdk/provider";
import { rerank } from "ai";
import type { SearchHit } from "./document-search";

/** A search hit that may carry a normalized (0..1) semantic similarity score. */
export interface RankableHit extends SearchHit {
  /** Cosine similarity of the page vs. the query, when produced by semantic retrieval. */
  semanticScore?: number;
}

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

/** Reciprocal Rank Fusion constant — dampens the weight of low ranks. */
const RRF_K = 60;

/**
 * Fuse semantic and lexical signals via Reciprocal Rank Fusion (RRF).
 *
 * Each hit contributes `1 / (RRF_K + rank)` for every ranked list it appears in:
 * a lexical list (term overlap over full page text) and a semantic list (the
 * `semanticScore` carried on the hit). Combining the two RANKS — rather than the
 * raw, differently-scaled scores — lets a semantically-strong but lexically-weak
 * page rank well without a page's high lexical count drowning out semantics.
 */
export function fuseSearchHits(
  query: string,
  hits: RankableHit[],
  pageTexts: Map<number, string>,
  limit = 30,
): SearchHit[] {
  if (hits.length <= 1) return hits;

  const rankMap = (scores: Array<number | null>): Map<number, number> => {
    const ranked = scores
      .map((s, i) => ({ i, s }))
      .filter((x): x is { i: number; s: number } => x.s != null && x.s > 0)
      .sort((a, b) => b.s - a.s);
    const rank = new Map<number, number>();
    ranked.forEach((x, r) => rank.set(x.i, r));
    return rank;
  };

  const lexRank = rankMap(
    hits.map((h) => lexicalScore(query, pageTexts.get(h.page) ?? h.snippet)),
  );
  const semRank = rankMap(hits.map((h) => h.semanticScore ?? null));

  return hits
    .map((h, i) => {
      let score = 0;
      const lr = lexRank.get(i);
      if (lr !== undefined) score += 1 / (RRF_K + lr);
      const sr = semRank.get(i);
      if (sr !== undefined) score += 1 / (RRF_K + sr);
      return { h, i, score };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.h);
}

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
