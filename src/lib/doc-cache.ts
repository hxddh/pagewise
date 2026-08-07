import { pickBetterPageText } from "./page-text-merge";
import type { LoadedDocument, PageText } from "./types";
import { searchDocumentPages } from "./document-search";
import { clearDocumentIndexState } from "./index-events";
import { flushIndexStore } from "./index-store";
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
        // Switching documents is the common way a session ends for the outgoing
        // one — persist whatever its sweep had buffered before it's gone.
        void flushIndexStore();
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
   * vision indexing lands.
   */
  upsertPageText(
    path: string,
    page: number,
    text: string,
    source: "native" | "vision" = "native",
  ): void {
    const doc = this.docs.get(path);
    if (!doc) return;

    const prev = doc.pages.find((p) => p.page === page);
    const merged = pickBetterPageText(prev?.text ?? "", text, prev?.source, source);
    // Provenance follows the text that won, so a later merge still knows which
    // side cost money.
    const mergedSource = prev && merged === prev.text ? prev.source : source;
    const exists = prev !== undefined;
    const next: PageText = { page, text: merged, source: mergedSource };
    const nextPages: PageText[] = exists
      ? doc.pages.map((p) => (p.page === page ? next : p))
      : [...doc.pages, next];
    nextPages.sort((a, b) => a.page - b.page);

    const nextDoc: LoadedDocument = { ...doc, pages: nextPages };
    this.docs.set(path, nextDoc);
    this.notify(path);
  }

  /**
   * Clear text a vision call produced, so a re-index can produce it again.
   *
   * Only vision text. A re-index runs because the reader changed their vision
   * model, and that has nothing to say about a page whose words came out of the
   * PDF's own text layer — which is also free, re-extracted on every open.
   * Clearing those made them look unindexed, and a page with no usable text is
   * exactly what the indexer sends to vision, so changing the model billed a
   * scan for every text page in the document.
   *
   * `source` is what tells the two apart; documents written before it existed
   * have none, and are treated as native so nothing free is thrown away on a
   * guess.
   *
   * When `pages` is omitted, every vision-indexed page is cleared.
   */
  invalidateIndexedPageText(path: string, pages?: number[]): void {
    const doc = this.docs.get(path);
    if (!doc) return;
    const pageSet = pages ? new Set(pages) : null;
    let changed = false;
    const nextPages = doc.pages.map((p) => {
      if (pageSet && !pageSet.has(p.page)) return p;
      if (p.source !== "vision") return p;

      if (p.text.trim().length === 0) return p;
      changed = true;
      return { page: p.page, text: "", source: undefined };
    });
    if (!changed) return;
    this.docs.set(path, { ...doc, pages: nextPages });
    this.notify(path);
  }

  /** Evict a closed document so its pages don't leak across the session. */
  remove(path: string): void {
    if (this.docs.delete(path)) {
      clearDocumentIndexState(path);
      void flushIndexStore();
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
