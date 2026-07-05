import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { semanticSearchPages } from "../lib/semantic-index";
import { docCache } from "../lib/doc-cache";
import type { SearchHit } from "../lib/document-search";
import { OPEN_DOC_SEARCH_EVENT } from "../lib/events";
import type { LoadedDocument } from "../lib/types";
import { useOverlayLock } from "../hooks/useOverlayLock";
import {
  isOverlayOpen,
  isTopOverlayLayer,
  popOverlayLayer,
  pushOverlayLayer,
} from "../lib/overlay-state";

interface DocumentSearchProps {
  doc: LoadedDocument;
  onJumpToPage: (page: number) => void;
}

export function DocumentSearch({ doc, onJumpToPage }: DocumentSearchProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  useOverlayLock(open);
  const layerRef = useRef<number | null>(null);

  // Own an escape layer while open so Escape only closes the topmost overlay.
  useEffect(() => {
    if (!open) return;
    const id = pushOverlayLayer();
    layerRef.current = id;
    return () => {
      popOverlayLayer(id);
      layerRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    const id = window.setTimeout(() => {
      const pages = docCache.getPages(doc.path);
      void semanticSearchPages(doc.path, pages, query, 30).then(setHits);
    }, 120);
    return () => window.clearTimeout(id);
  }, [query, doc.pages]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        // Don't open search underneath a modal/drawer/palette.
        if (!open && isOverlayOpen()) return;
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === "Escape" && open && isTopOverlayLayer(layerRef.current ?? -1)) {
        setOpen(false);
        setQuery("");
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

  if (!open) return null;

  return (
    <div className="doc-search-overlay" role="presentation">
      <button
        type="button"
        className="doc-search-backdrop"
        aria-label={t("preview.closeSearch")}
        onClick={() => {
          setOpen(false);
          setQuery("");
        }}
      />
      <div className="doc-search-panel" role="dialog" aria-modal="true" aria-label={t("preview.search")}>
        <input
          className="doc-search-input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("preview.searchPlaceholder")}
          autoFocus
        />
        <button
          type="button"
          className="btn icon-btn"
          onClick={() => {
            setOpen(false);
            setQuery("");
          }}
          aria-label={t("preview.closeSearch")}
        >
          ×
        </button>
        {query.trim() && (
          <div className="doc-search-results">
            {hits.length === 0 ? (
              <p className="doc-search-empty">{t("preview.noMatches")}</p>
            ) : (
              <>
                <p className="doc-search-count">
                  {t("preview.matchCount", { count: hits.length })}
                </p>
                <ul>
                  {hits.map((hit, i) => (
                    <li key={`${hit.page}-${hit.index}-${i}`}>
                      <button
                        type="button"
                        className="doc-search-hit"
                        onClick={() => {
                          onJumpToPage(hit.page);
                          setOpen(false);
                          setQuery("");
                        }}
                      >
                        <span className="hit-page">{t("preview.pageHit", { page: hit.page })}</span>
                        <span className="hit-snippet">{hit.snippet}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
