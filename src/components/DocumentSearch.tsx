import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useI18n } from "../i18n";
import { MAX_SEARCH_HITS, searchDocumentPages, type SearchHit } from "../lib/document-search";
import { rankPages, type RankedHit } from "../lib/ranked-search";
import { searchMessages } from "../lib/conversation-search";
import { useSearchScope } from "./SearchScope";
import { docCache } from "../lib/doc-cache";
import { MIN_INDEX_CHARS } from "../lib/page-text-merge";
import { OPEN_DOC_SEARCH_EVENT, type OpenDocSearchDetail } from "../lib/events";
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
  containerRef?: RefObject<HTMLElement | null>;
}

export function DocumentSearch({ doc, onJumpToPage, containerRef }: DocumentSearchProps) {
  const { t } = useI18n();
  const scope = useSearchScope();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [relatedHits, setRelatedHits] = useState<RankedHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [resultsCollapsed, setResultsCollapsed] = useState(false);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const searchGenRef = useRef(0);

  const close = useCallback(() => {
    setOpen(false);
    setResultsCollapsed(false);
    onJumpToPage(doc.pages[0]?.page ?? 1, undefined);
  }, [doc.pages, onJumpToPage]);

  const dismissBar = useCallback(() => {
    setOpen(false);
    setResultsCollapsed(false);
  }, []);

  const [cacheRevision, setCacheRevision] = useState(0);

  useEffect(() => {
    return docCache.subscribe((path) => {
      if (path === doc.path) setCacheRevision((r) => r + 1);
    });
  }, [doc.path]);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      setRelatedHits([]);
      setActiveIndex(0);
      setSearching(false);
      return;
    }
    const gen = ++searchGenRef.current;
    setSearching(true);
    setResultsCollapsed(false);
    const id = window.setTimeout(() => {
      const pages = docCache.getPages(doc.path);
      const results = searchDocumentPages(pages, query, MAX_SEARCH_HITS);
      const related = results.length === 0 && query.trim().length >= 2 ? rankPages(pages, query, 5) : [];
      if (gen !== searchGenRef.current) return;
      setHits(results);
      setRelatedHits(related);
      setActiveIndex(0);
      setSearching(false);
    }, 100);
    return () => {
      window.clearTimeout(id);
    };
  }, [query, doc.path, cacheRevision]);

  const messageMatches = useMemo(
    () => (query.trim() && scope ? searchMessages(scope.messages, query) : []),
    [query, scope],
  );

  const stepHit = useCallback(
    (delta: 1 | -1) => {
      if (hits.length === 0) return;
      const next = (activeIndex + delta + hits.length) % hits.length;
      setActiveIndex(next);
      const hit = hits[next]!;
      onJumpToPage(hit.page, query);
    },
    [activeIndex, hits, onJumpToPage, query],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "f") {
        if (!open && isOverlayOpen()) return;
        e.preventDefault();
        setOpen(true);
        setResultsCollapsed(false);
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
        return;
      }
      if (open && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") {
        e.preventDefault();
        stepHit(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, stepHit]);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const nextQuery = (e as CustomEvent<OpenDocSearchDetail | null>).detail?.query;
      if (nextQuery) setQuery(nextQuery);
      setOpen(true);
      setResultsCollapsed(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener(OPEN_DOC_SEARCH_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_DOC_SEARCH_EVENT, onOpen);
  }, []);

  const conversation = scope && scope.messages.length > 0 ? scope : null;

  return (
    <Modal
      open={open}
      modal={false}
      onClose={dismissBar}
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
        onFocus={() => setResultsCollapsed(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && hits.length > 0) {
            e.preventDefault();
            if (e.shiftKey) stepHit(-1);
            else {
              const target = hits[activeIndex] ?? hits[0]!;
              onJumpToPage(target.page, query);
              setActiveIndex((prev) => (prev + 1) % hits.length);
            }
          }
        }}
        placeholder={t("preview.searchPlaceholder")}
      />
      {hits.length > 0 && (
        <span className="doc-search-step-count" aria-live="polite">
          {Math.min(activeIndex + 1, hits.length)} / {hits.length}
        </span>
      )}
      {hits.length > 1 && (
        <>
          <Button
            variant="ghost"
            size="sm"
            icon
            onClick={() => stepHit(-1)}
            aria-label={t("preview.previousMatch")}
            title={t("preview.previousMatch")}
          >
            <ChevronUp size={14} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon
            onClick={() => stepHit(1)}
            aria-label={t("preview.nextMatch")}
            title={t("preview.nextMatch")}
          >
            <ChevronDown size={14} />
          </Button>
        </>
      )}
      <Button
        variant="ghost"
        size="md"
        icon
        onClick={() => {
          setQuery("");
          close();
        }}
        aria-label={t("preview.closeSearch")}
      >
        ×
      </Button>
      {query.trim() && !resultsCollapsed && (
        <Panel tone="elevated" className="doc-search-results">
          {searching ? (
            <EmptyState variant="inline" className="doc-search-empty" live="polite">
              {t("preview.searching")}
            </EmptyState>
          ) : (
            <>
              <section className="doc-search-section">
                <p className="doc-search-count">
                  {t("preview.searchDocHeading")}
                  {hits.length > 0 && (
                    <span className="doc-search-section-count">
                      {t("preview.matchCount", { count: hits.length })}
                    </span>
                  )}
                </p>
                {hits.length === 0 ? (
                  relatedHits.length > 0 ? (
                    <>
                      <p className="doc-search-count">{t("preview.searchRelatedHeading")}</p>
                      <ul>
                        {relatedHits.map((hit) => (
                          <li key={`rel-${hit.page}`}>
                            <ListRow
                              className="doc-search-hit"
                              onClick={() => {
                                onJumpToPage(hit.page, hit.terms[0] ?? query);
                                setResultsCollapsed(true);
                              }}
                              label={<span className="hit-page">{t("preview.pageHit", { page: hit.page })}</span>}
                              meta={<span className="hit-snippet">{highlightTerms(hit.snippet, hit.terms.join(" "))}</span>}
                            />
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <EmptyState variant="inline" className="doc-search-empty" live="polite">
                      {docCache
                        .getPages(doc.path)
                        .some((p) => p.text.trim().length < MIN_INDEX_CHARS)
                        ? t("preview.searchIndexing")
                        : t("preview.noMatches")}
                    </EmptyState>
                  )
                ) : (
                  <ul>
                    {hits.map((hit, i) => (
                      <li key={`${hit.page}-${hit.index}-${i}`}>
                        <ListRow
                          className={`doc-search-hit${i === activeIndex ? " active" : ""}`}
                          onClick={() => {
                            setActiveIndex(i);
                            onJumpToPage(hit.page, query);
                            setResultsCollapsed(true);
                          }}
                          label={<span className="hit-page">{t("preview.pageHit", { page: hit.page })}</span>}
                          meta={<span className="hit-snippet">{highlightTerms(hit.snippet, query)}</span>}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              {conversation && (
                <section className="doc-search-section">
                  <p className="doc-search-count">
                    {t("preview.searchConversationHeading")}
                    {messageMatches.length > 0 && (
                      <span className="doc-search-section-count">
                        {t("preview.matchCount", { count: messageMatches.length })}
                      </span>
                    )}
                  </p>
                  {messageMatches.length === 0 ? (
                    <EmptyState variant="inline" className="doc-search-empty" live="polite">
                      {t("preview.noMatches")}
                    </EmptyState>
                  ) : (
                    <ul>
                      {messageMatches.map((match) => (
                        <li key={match.id}>
                          <ListRow
                            className="doc-search-hit"
                            onClick={() => {
                              conversation.gotoMessage(match.id);
                              setResultsCollapsed(true);
                            }}
                            label={<span className="hit-snippet">{highlightTerms(match.excerpt, query)}</span>}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </>
          )}
        </Panel>
      )}
    </Modal>
  );
}

export function highlightTerms(snippet: string, query: string): ReactNode {
  const terms = [...new Set(query.trim().split(/\s+/).filter((w) => w.length > 0))]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (terms.length === 0) return snippet;
  const re = new RegExp(`(${terms.join("|")})`, "gi");
  const parts = snippet.split(re);
  return parts.map((part, i) => (i % 2 === 1 ? <mark key={i} className="hit-term">{part}</mark> : part));
}
