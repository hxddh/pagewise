import type { LoadedDocument, PageText } from "./types";
import { searchDocumentPages } from "./document-search";
import { clearSemanticIndex } from "./semantic-index";

type DocCacheListener = (path: string) => void;

const MAX_CACHED_DOCS = 12;

class DocCache {
  private docs = new Map<string, LoadedDocument>();
  private listeners = new Set<DocCacheListener>();

  set(doc: LoadedDocument): void {
    if (!this.docs.has(doc.path) && this.docs.size >= MAX_CACHED_DOCS) {
      const oldest = this.docs.keys().next().value;
      if (oldest) this.docs.delete(oldest);
    }
    this.docs.set(doc.path, doc);
    this.notify(doc.path);
  }

  get(path: string): LoadedDocument | undefined {
    return this.docs.get(path);
  }

  /** True when `path` is a currently-loaded document (used to gate tool file access). */
  has(path: string): boolean {
    return this.docs.has(path);
  }

  getPages(path: string): PageText[] {
    return this.docs.get(path)?.pages ?? [];
  }

  /**
   * Update a page's text immutably: produces a new pages array and a new
   * document object so React state consumers re-render when background
   * vision/OCR indexing lands.
   */
  upsertPageText(path: string, page: number, text: string): void {
    const doc = this.docs.get(path);
    if (!doc) return;

    const exists = doc.pages.some((p) => p.page === page);
    const nextPages: PageText[] = exists
      ? doc.pages.map((p) => (p.page === page ? { page, text } : p))
      : [...doc.pages, { page, text }];
    nextPages.sort((a, b) => a.page - b.page);

    const nextDoc: LoadedDocument = { ...doc, pages: nextPages };
    this.docs.set(path, nextDoc);
    this.notify(path);
  }

  /** Evict a closed document so its pages don't leak across the session. */
  remove(path: string): void {
    if (this.docs.delete(path)) {
      clearSemanticIndex(path);
      this.notify(path);
    }
  }

  clear(): void {
    const paths = [...this.docs.keys()];
    this.docs.clear();
    for (const path of paths) this.notify(path);
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

  /** Subscribe to cache mutations (set/upsert/remove). Returns an unsubscribe fn. */
  subscribe(listener: DocCacheListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(path: string): void {
    for (const listener of this.listeners) {
      try {
        listener(path);
      } catch {
        // A misbehaving subscriber must not break cache updates.
      }
    }
  }
}

export const docCache = new DocCache();
