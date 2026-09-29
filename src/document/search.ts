import { searchDocumentPages } from "../lib/document-search";
import { rankPages } from "../lib/ranked-search";

export interface AgentSearchHit {
  page: number;
  snippet: string;
  /**
   * Present on a hit found by its words rather than the phrase: the page has
   * the query's terms, not necessarily together. Absent on an exact match.
   */
  match?: "terms";
}

export function searchInDocument(
  pages: Array<{ page: number; text: string }>,
  query: string,
  limit = 30,
): AgentSearchHit[] {
  return searchDocumentPages(pages, query, limit).map((h) => ({
    page: h.page,
    snippet: h.snippet,
  }));
}

/**
 * The assistant's search: every exact occurrence, in page order, as it always
 * was — and only when there is none, the pages that carry the query's words,
 * ranked by how well (`ranked-search.ts`), each marked `match: "terms"`.
 *
 * Until 13.0 a query in the reader's words rather than the document's found
 * nothing at all, and the model's next move was to page through the document.
 * A query whose phrase IS on a page gets exactly what it got before: looser
 * matches would be noise beside the phrase it asked for, and every hit is sent
 * to the model and paid for.
 */
export function searchForAgent(
  pages: Array<{ page: number; text: string }>,
  query: string,
  limit = 30,
): AgentSearchHit[] {
  const exact = searchInDocument(pages, query, limit);
  if (exact.length > 0) return exact;
  return rankPages(pages, query, limit).map((h) => ({ page: h.page, snippet: h.snippet, match: "terms" as const }));
}
