import type { PageText } from "./types";

export interface SearchHit {
  page: number;
  index: number;
  snippet: string;
  match: string;
}

// Wider context so a single search hit is often enough to answer a lookup
// without a follow-up read, and so a table/figure cell reads as a real match.
function snippetAround(text: string, index: number, matchLen: number, radius = 120): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + matchLen + radius);
  const chunk = text.slice(start, end).replace(/\s+/g, " ").trim();
  return start > 0 ? `…${chunk}` : chunk;
}

/**
 * Case-fold a string while recording, for each folded UTF-16 unit, the offset of
 * its source char in the input. Folding is done per code point because
 * String.prototype.toLowerCase can change length (e.g. U+0130 "İ" -> "i" + combining
 * dot), which would otherwise desync folded indices from the source string.
 */
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let origOffset = 0;
  for (const ch of text) {
    const low = ch.toLowerCase();
    for (const unit of low) {
      folded += unit;
      map.push(origOffset);
    }
    origOffset += ch.length;
  }
  return { folded, map };
}

export function searchDocumentPages(
  pages: PageText[],
  query: string,
  limit = 80,
): SearchHit[] {
  const rawQuery = query.trim();
  if (!rawQuery) return [];

  // Normalize to NFC so composed/decomposed forms of the same text match, then
  // case-fold. The query is folded once up front.
  const foldedQuery = foldWithMap(rawQuery.normalize("NFC")).folded;
  if (!foldedQuery) return [];

  const hits: SearchHit[] = [];

  for (const { page, text } of pages) {
    if (hits.length >= limit) break;
    const normText = text.normalize("NFC");
    const { folded, map } = foldWithMap(normText);

    let from = 0;
    while (hits.length < limit) {
      const idx = folded.indexOf(foldedQuery, from);
      if (idx === -1) break;

      // Map folded positions back to source offsets so snippets stay aligned.
      const startOrig = map[idx] ?? 0;
      const endFold = idx + foldedQuery.length;
      const endOrig = endFold < map.length ? map[endFold]! : normText.length;

      hits.push({
        page,
        index: startOrig,
        match: normText.slice(startOrig, endOrig),
        snippet: snippetAround(normText, startOrig, endOrig - startOrig),
      });
      from = idx + Math.max(1, foldedQuery.length);
    }
  }

  return hits;
}

export function countSearchHits(pages: PageText[], query: string): number {
  return searchDocumentPages(pages, query, Number.MAX_SAFE_INTEGER).length;
}
