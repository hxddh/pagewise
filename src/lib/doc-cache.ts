import type { LoadedDocument, PageText } from "./types";
import { searchDocumentPages } from "./document-search";

class DocCache {
  private docs = new Map<string, LoadedDocument>();

  set(doc: LoadedDocument): void {
    this.docs.set(doc.path, doc);
  }

  get(path: string): LoadedDocument | undefined {
    return this.docs.get(path);
  }

  getPages(path: string): PageText[] {
    return this.docs.get(path)?.pages ?? [];
  }

  list(): LoadedDocument[] {
    return [...this.docs.values()];
  }

  search(path: string, query: string): Array<{ page: number; snippet: string }> {
    const pages = this.getPages(path);
    return searchDocumentPages(pages, query, 30).map((h) => ({
      page: h.page,
      snippet: h.snippet,
    }));
  }
}

export const docCache = new DocCache();
