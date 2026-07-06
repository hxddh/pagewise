import { searchDocumentPages } from "../lib/document-search";

export function searchInDocument(
  pages: Array<{ page: number; text: string }>,
  query: string,
  limit = 30,
): Array<{ page: number; snippet: string }> {
  return searchDocumentPages(pages, query, limit).map((h) => ({
    page: h.page,
    snippet: h.snippet,
  }));
}
