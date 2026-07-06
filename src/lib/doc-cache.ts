import { pickBetterPageText, MIN_INDEX_CHARS } from "./page-text-merge";
import type { LoadedDocument, PageText } from "./types";
import { searchDocumentPages } from "./document-search";
import { clearDocumentIndexState } from "./index-events";
import { mergePageTextsOnReload, pagesTextChanged } from "./page-text-merge";

type DocCacheListener = (path: string) => void;

const MAX_CACHED_DOCS = 1;

class DocCache {
  private docs = new Map<string, LoadedDocument>();
  private listeners = new Set<DocCacheListener>();

  set(doc: LoadedDocument): void {
    if (!this.docs.has(doc.path) && this.docs.size >= MAX_CACHED_DOCS) {
      const oldest = this.docs.keys().next().value;
      if (oldest) {
        this.docs.delete(oldest);
        clearDocumentIndexState(oldest);
      }
    }
    const existing = this.docs.get(doc.path);
    let nextDoc = doc;
    if (existing) {
      const mergedPages = mergePageTextsOnReload(existing.pages, doc.pages);
      nextDoc = { ...doc, pages: mergedPages };
      if (pagesTextChanged(existing.pages, mergedPages)) {
        /* page text updated on reload */
      }
    }
    this.docs.set(doc.path, nextDoc);
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

    const existing = doc.pages.find((p) => p.page === page)?.text ?? "";
    const merged = pickBetterPageText(existing, text);
    const exists = doc.pages.some((p) => p.page === page);
    const nextPages: PageText[] = exists
      ? doc.pages.map((p) => (p.page === page ? { page, text: merged } : p))
      : [...doc.pages, { page, text: merged }];
    nextPages.sort((a, b) => a.page - b.page);

    const nextDoc: LoadedDocument = { ...doc, pages: nextPages };
    this.docs.set(path, nextDoc);
    this.notify(path);
  }

  /**
   * Clear indexed page text so vision/OCR reindex can rerun.
   * When `pages` is omitted, clears every page with ≥ MIN_INDEX_CHARS.
   */
  invalidateIndexedPageText(path: string, pages?: number[]): void {
    const doc = this.docs.get(path);
    if (!doc) return;
    const pageSet = pages ? new Set(pages) : null;
    let changed = false;
    const nextPages = doc.pages.map((p) => {
      if (pageSet && !pageSet.has(p.page)) return p;
      if (!pageSet && p.text.trim().length < MIN_INDEX_CHARS) return p;
      if (p.text.trim().length === 0) return p;
      changed = true;
      return { page: p.page, text: "" };
    });
    if (!changed) return;
    this.docs.set(path, { ...doc, pages: nextPages });
    this.notify(path);
  }

  /** Evict a closed document so its pages don't leak across the session. */
  remove(path: string): void {
    if (this.docs.delete(path)) {
      clearDocumentIndexState(path);
      this.notify(path);
    }
  }

  clear(): void {
    const paths = [...this.docs.keys()];
    this.docs.clear();
    for (const path of paths) {
      clearDocumentIndexState(path);
      this.notify(path);
    }
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
