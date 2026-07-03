import { useEffect, useState } from "react";
import { searchDocumentPages, type SearchHit } from "../lib/document-search";
import { OPEN_DOC_SEARCH_EVENT } from "../lib/events";
import type { LoadedDocument } from "../lib/types";

interface DocumentSearchProps {
  doc: LoadedDocument;
  onJumpToPage: (page: number) => void;
}

export function DocumentSearch({ doc, onJumpToPage }: DocumentSearchProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    const id = window.setTimeout(() => {
      setHits(searchDocumentPages(doc.pages, query));
    }, 120);
    return () => window.clearTimeout(id);
  }, [query, doc.pages]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
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

  if (!open) {
    return (
      <button
        type="button"
        className="btn ghost toolbar-btn"
        onClick={() => setOpen(true)}
        title="Search in document (⌘F)"
      >
        Search
      </button>
    );
  }

  return (
    <div className="doc-search">
      <input
        className="doc-search-input"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search in document…"
        autoFocus
      />
      <button type="button" className="btn icon-btn" onClick={() => setOpen(false)} aria-label="Close search">
        ×
      </button>
      {query.trim() && (
        <div className="doc-search-results">
          {hits.length === 0 ? (
            <p className="doc-search-empty">No matches</p>
          ) : (
            <>
              <p className="doc-search-count">
                {hits.length} match{hits.length === 1 ? "" : "es"}
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
                      }}
                    >
                      <span className="hit-page">p. {hit.page}</span>
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
  );
}
