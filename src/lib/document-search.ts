import type { PageText } from "./types";

export interface SearchHit {
  page: number;
  index: number;
  snippet: string;
  match: string;
}

function snippetAround(text: string, index: number, matchLen: number, radius = 48): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + matchLen + radius);
  const chunk = text.slice(start, end).replace(/\s+/g, " ").trim();
  return start > 0 ? `…${chunk}` : chunk;
}

export function searchDocumentPages(
  pages: PageText[],
  query: string,
  limit = 80,
): SearchHit[] {
  const q = query.trim();
  if (!q) return [];

  const lowerQ = q.toLowerCase();
  const hits: SearchHit[] = [];

  for (const { page, text } of pages) {
    const lower = text.toLowerCase();
    let from = 0;
    while (from < lower.length && hits.length < limit) {
      const idx = lower.indexOf(lowerQ, from);
      if (idx === -1) break;
      hits.push({
        page,
        index: idx,
        match: text.slice(idx, idx + q.length),
        snippet: snippetAround(text, idx, q.length),
      });
      from = idx + Math.max(1, q.length);
    }
  }

  return hits;
}

export function countSearchHits(pages: PageText[], query: string): number {
  return searchDocumentPages(pages, query, Number.MAX_SAFE_INTEGER).length;
}
