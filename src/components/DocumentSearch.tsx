import type { ReactNode, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { searchDocumentPages, type SearchHit } from "../lib/document-search";
import { docCache } from "../lib/doc-cache";
import { MIN_INDEX_CHARS } from "../lib/page-text-merge";
import { OPEN_DOC_SEARCH_EVENT } from "../lib/events";
import type { LoadedDocument } from "../lib/types";
import { isOverlayOpen } from "../lib/overlay-state";
import { Button } from "./ui/Button";
import { Input } from "./ui/Field";
import { Panel } from "./ui/Panel";
import { ListRow } from "./ui/ListRow";
import { Modal } from "./ui/Modal";
import { EmptyState } from "./EmptyState";

interface DocumentSearchProps {
  doc: LoadedDocument;
  onJumpToPage: (page: number, query?: string) => void;
  /**
   * Where the search portals to: the preview panel, not the window. The panel
   * is a translucent bar over the document it searches, so it has to stay
   * inside the panel's box.
   */
  containerRef?: RefObject<HTMLElement | null>;
}

export function DocumentSearch({ doc, onJumpToPage, containerRef }: DocumentSearchProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const searchGenRef = useRef(0);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const [cacheRevision, setCacheRevision] = useState(0);

  useEffect(() => {
    return docCache.subscribe((path) => {
      if (path === doc.path) setCacheRevision((r) => r + 1);
    });
  }, [doc.path]);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      setSearching(false);
      return;
    }
    const gen = ++searchGenRef.current;
    setSearching(true);
    const id = window.setTimeout(() => {
      const pages = docCache.getPages(doc.path);
      const results = searchDocumentPages(pages, query, 30);
      if (gen !== searchGenRef.current) return;
      setHits(results);
      setSearching(false);
    }, 120);
    return () => {
      window.clearTimeout(id);
    };
  }, [query, doc.path, cacheRevision]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // `!e.shiftKey`: ⌘⇧F is Zen (18.0). Without this the chord opened the
      // document search *and* hid the chrome, which is how a shortcut added in
      // one place quietly takes a key away from another.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "f") {
        if (!open && isOverlayOpen()) return;
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_DOC_SEARCH_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_DOC_SEARCH_EVENT, onOpen);
  }, []);

  return (
    <Modal
      open={open}
      onClose={close}
      overlayClassName="doc-search-overlay"
      className="doc-search-panel"
      container={containerRef?.current ?? null}
      ariaLabel={t("preview.search")}
      initialFocus={inputRef}
    >
      <Input
        ref={inputRef}
        size="sm"
        className="doc-search-input"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("preview.searchPlaceholder")}
      />
      <Button variant="ghost" size="md" icon onClick={close} aria-label={t("preview.closeSearch")}>
        ×
      </Button>
      {query.trim() && (
        <Panel tone="elevated" className="doc-search-results">
          {searching ? (
            <EmptyState variant="inline" className="doc-search-empty" live="polite">
              {t("preview.searching")}
            </EmptyState>
          ) : hits.length === 0 ? (
            <EmptyState variant="inline" className="doc-search-empty" live="polite">
              {docCache
                .getPages(doc.path)
                .some((p) => p.text.trim().length < MIN_INDEX_CHARS)
                ? t("preview.searchIndexing")
                : t("preview.noMatches")}
            </EmptyState>
          ) : (
            <>
              <p className="doc-search-count">
                {t("preview.matchCount", { count: hits.length })}
              </p>
              <ul>
                {hits.map((hit, i) => (
                  <li key={`${hit.page}-${hit.index}-${i}`}>
                    <ListRow
                      className="doc-search-hit"
                      onClick={() => {
                        // The query travels with the jump so the page can
                        // show where the hit is, not just which page it is on.
                        onJumpToPage(hit.page, query);
                        close();
                      }}
                      label={<span className="hit-page">{t("preview.pageHit", { page: hit.page })}</span>}
                      meta={<span className="hit-snippet">{highlightTerms(hit.snippet, query)}</span>}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>
      )}
    </Modal>
  );
}

/**
 * The snippet with the searched words marked (16.0). A list of results that
 * all begin "Section 1 Lorem ipsum…" said nothing about where in each the
 * words were.
 */
export function highlightTerms(snippet: string, query: string): ReactNode {
  const terms = [...new Set(query.trim().split(/\s+/).filter((w) => w.length > 0))]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (terms.length === 0) return snippet;
  const re = new RegExp(`(${terms.join("|")})`, "gi");
  const parts = snippet.split(re);
  return parts.map((part, i) => (i % 2 === 1 ? <mark key={i} className="hit-term">{part}</mark> : part));
}
