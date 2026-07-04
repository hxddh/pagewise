import type { PageText } from "./types";
import { cosineSimilarity, embedText, embedTexts } from "./embeddings";
import { loadSettings } from "./settings";
import { searchDocumentPages, type SearchHit } from "./document-search";
import { rerankSearchHits } from "./search-rerank";

interface PageEmbedding {
  page: number;
  vector: number[];
}

const store = new Map<string, PageEmbedding[]>();
const building = new Set<string>();

function pageEmbedText(text: string, page: number): string {
  const trimmed = text.trim();
  if (!trimmed) return `Page ${page}`;
  return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}…` : trimmed;
}

export function clearSemanticIndex(path: string): void {
  store.delete(path);
  building.delete(path);
}

export async function ensureSemanticIndex(
  path: string,
  pages: PageText[],
): Promise<void> {
  if (store.has(path) || building.has(path)) return;
  const sparse = pages.filter((p) => p.text.trim().length >= 20);
  if (sparse.length === 0) return;

  building.add(path);
  try {
    const settings = await loadSettings();
    const values = sparse.map((p) => pageEmbedText(p.text, p.page));
    const vectors = await embedTexts(settings, values);
    const entries: PageEmbedding[] = [];
    for (let i = 0; i < sparse.length; i++) {
      const vector = vectors[i];
      if (vector && vector.length > 0) {
        entries.push({ page: sparse[i]!.page, vector });
      }
    }
    if (entries.length > 0) store.set(path, entries);
  } finally {
    building.delete(path);
  }
}

export async function semanticSearchPages(
  path: string,
  pages: PageText[],
  query: string,
  limit = 30,
): Promise<SearchHit[]> {
  const keywordHits = searchDocumentPages(pages, query, limit);
  await ensureSemanticIndex(path, pages);
  const indexed = store.get(path);
  if (!indexed?.length) return keywordHits;

  const settings = await loadSettings();
  const queryVector = await embedText(settings, query);
  if (!queryVector) return keywordHits;

  const pageText = new Map(pages.map((p) => [p.page, p.text]));
  const semanticHits: SearchHit[] = indexed
    .map((entry) => ({
      page: entry.page,
      score: cosineSimilarity(queryVector, entry.vector),
      text: pageText.get(entry.page) ?? "",
    }))
    .filter((h) => h.score > 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((h) => {
      const snippet = h.text.trim().slice(0, 120).replace(/\s+/g, " ");
      return {
        page: h.page,
        index: 0,
        match: query,
        snippet: snippet ? `…${snippet}…` : `Page ${h.page}`,
      };
    });

  const seen = new Set<string>();
  const merged: SearchHit[] = [];
  for (const hit of [...semanticHits, ...keywordHits]) {
    const key = `${hit.page}:${hit.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
    if (merged.length >= limit) break;
  }

  return rerankSearchHits(query, merged, pageText, limit);
}
