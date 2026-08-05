import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ConfirmOverlay } from "../../components/overlays/ConfirmOverlay";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { useToast } from "../../hooks/useToast";
import { usePageIndexStatus } from "../../hooks/usePageIndexStatus";
import { getPageIndexState, clearPageIndexState } from "../../lib/index-events";
import { sanitizeIndexErrorDetail } from "../../lib/index-error-display";
import { getPageTextLen, pageHasIndexableText } from "../../lib/doc-text";
import { isRasterHeavyPage } from "../../lib/pdf";
import { indexPageInBackground } from "../../document/index-queue";
import { useSettled } from "../../lib/use-settled";
import { usePdfViewer } from "./usePdfViewer";
import { useAskSelection } from "./useAskSelection";
import { selectionQuote } from "./selection-quote";
import { SearchHighlight } from "./SearchHighlight";
import { LinkLayer } from "./LinkLayer";
import { MarkLayer } from "./MarkLayer";
import { RegionSelectLayer } from "./RegionSelectLayer";
import { PageScroller } from "./PageScroller";
import { regionSnapshot } from "./region-snapshot";
import { MarkNote } from "./MarkNote";
import { useMarkRevision } from "./useMarks";
import { addMark, getMarks, marksAreStale } from "../../lib/mark-store";
import { extractRegion } from "../../lib/pdf";
import { clientRectToPageRect } from "./selection-quote";
import { getPageGeometry } from "../../lib/pdf";
import { displayUrl } from "../../lib/safe-link";
import type { LoadedDocument } from "../../lib/types";
import { PreviewToolbar } from "../../components/PreviewToolbar";
import { ThumbnailSidebar } from "../../components/ThumbnailSidebar";
import { OutlineSidebar } from "../../components/OutlineSidebar";
import { MarkSidebar } from "../../components/MarkSidebar";
import { usableOutline } from "../../lib/outline-nav";
import { DocumentSearch } from "../../components/DocumentSearch";

/** How long the page has to stay put before it counts as being read. */
const INDEX_SETTLE_MS = 500;

interface PreviewPaneProps {
  doc: LoadedDocument;
  page: number;
  onPageChange: (page: number) => void;
  prefsRevision?: number;
  onOpenAiSettings?: () => void;
  onAskAboutSelection?: (text: string) => void;
}

function PreviewPaneInner({
  doc,
  page,
  onPageChange,
  prefsRevision = 0,
  onOpenAiSettings,
  onAskAboutSelection,
}: PreviewPaneProps) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [thumbsVisible, setThumbsVisible] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<"pages" | "outline" | "marks">("pages");
  const [selectedMarkId, setSelectedMarkId] = useState<string | null>(null);
  const [regionMode, setRegionMode] = useState(false);
  const markRevision = useMarkRevision(doc.path);
  // What the reader searched for when they jumped here, so the hit can be
  // marked on the page. Cleared as soon as they navigate away from it.
  const [searchHit, setSearchHit] = useState<{ page: number; query: string } | null>(null);
  // A link the reader clicked, held until they confirm. Document URLs are
  // untrusted input, so nothing opens the browser on its own.
  const [pendingLink, setPendingLink] = useState<string | null>(null);

  const viewer = usePdfViewer({ doc, page, onPageChange, prefsRevision });
  // Bumped whenever the view changes or this pane goes away, so an in-flight
  // selection read can tell that its answer no longer belongs anywhere.
  const quoteRun = useRef(0);
  useEffect(() => () => {
    quoteRun.current += 1;
  }, [doc.path]);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const bindScroller = useCallback(
    (node: HTMLDivElement | null) => {
      scrollerRef.current = node;
      viewer.bindScroller(node);
    },
    [viewer],
  );
  const [askSel, clearAskSel] = useAskSelection(
    scrollerRef,
    !!onAskAboutSelection && doc.kind === "pdf",
  );

  const askButton =
    askSel && onAskAboutSelection ? (
      <button
        type="button"
        className="ask-selection-btn"
        // Keep the selection alive through the click.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const box = askSel.pageBox;
          const selectionRect = askSel.rect;
          const selPage = askSel.page;
          const run = quoteRun.current;
          clearAskSel();
          window.getSelection()?.removeAllRanges();
          void selectionQuote(doc.path, selPage, askSel.text, selectionRect, box).then(
            (quote) => {
              // Reading the region is a round trip, and the user can turn the
              // page or open another document while it is in flight. Dropping
              // a superseded result keeps a quote from the old page out of the
              // new one's composer.
              if (quoteRun.current !== run) return;
              // The composer takes the text as given, so the quotation marks
              // that make it read as a citation belong here, where we know this
              // is a passage rather than a sentence about one.
              onAskAboutSelection(`"${quote}"`);
            },
          );
        }}
      >
        {t("preview.askAboutSelection")}
      </button>
    ) : null;

  const markButton =
    askSel && doc.kind === "pdf" ? (
      <button
        type="button"
        className="mark-selection-btn"
        // Keep the selection alive through the click.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const box = askSel.pageBox;
          const rects = askSel.rects;
          const selPage = askSel.page;
          const text = askSel.text;
          const run = quoteRun.current;
          clearAskSel();
          window.getSelection()?.removeAllRanges();
          if (!box) return;
          void (async () => {
            try {
              const geometry = await getPageGeometry(doc.path, selPage);
              // The page a selection belongs to came out of the selection
              // itself, so scrolling on cannot move the mark.
              if (quoteRun.current !== run) return;
              const mark = addMark(doc.path, {
                page: selPage,
                rects: rects.map((r) => clientRectToPageRect(r, box, geometry)),
                // The words are a snapshot for the reader, never an anchor —
                // the rectangles locate the mark.
                text,
                stamp: doc.stamp ?? "",
              });
              if (mark) setSelectedMarkId(mark.id);
              else showToast(t("marks.capReached"), "error");
            } catch {
              // Nothing to place the mark against; leaving the page unmarked is
              // better than marking it in the wrong spot.
            }
          })();
        }}
      >
        {t("marks.markSelection")}
      </button>
    ) : null;

  // Leaving the mode has to be possible without finding the button again.
  useEffect(() => {
    if (!regionMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setRegionMode(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [regionMode]);

  // The page below indexes itself when it has no text of its own, and indexing
  // a scanned page is a billed vision call. While the preview flipped one page
  // at a time, a click cost at most one call. Scrolling changes the current
  // page continuously, so an unsettled page number would spend a call on every
  // page scrolled *past* — a 200-page scan, scrolled through once, unattended.
  // The page you are looking at is the one you stopped on.
  const indexPage = useSettled(doc.kind === "pdf" ? page : 1, INDEX_SETTLE_MS);
  const indexState = usePageIndexStatus(doc.path, indexPage);
  const pageTextLen = getPageTextLen(doc.path, indexPage, doc.pages);

  useEffect(() => {
    if (pageHasIndexableText(doc.path, indexPage, doc.pages)) return;
    const state = getPageIndexState(doc.path, indexPage);
    if (state?.status === "indexing") return;
    if (state?.status === "failed") return;
    if (state?.status === "done" && pageHasIndexableText(doc.path, indexPage, doc.pages)) {
      return;
    }
    indexPageInBackground(doc.path, indexPage);
  }, [doc.path, doc.kind, indexPage, pageTextLen]);

  const transientRetryRef = useRef(0);

  useEffect(() => {
    transientRetryRef.current = 0;
  }, [doc.path, indexPage]);

  useEffect(() => {
    const state = getPageIndexState(doc.path, indexPage);
    if (state?.status !== "failed") return;
    const detail = sanitizeIndexErrorDetail(state.error);
    const transient = detail === "timeout";
    if (!transient) return;
    if (transientRetryRef.current >= 6) return;

    const delayMs = Math.min(30_000, 4000 * 2 ** transientRetryRef.current);
    const timer = window.setTimeout(() => {
      if (pageHasIndexableText(doc.path, indexPage, doc.pages)) return;
      transientRetryRef.current += 1;
      clearPageIndexState(doc.path, indexPage);
      indexPageInBackground(doc.path, indexPage);
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [doc.path, doc.kind, indexPage, indexState?.status, indexState?.error, indexState?.failureReason]);

  const indexHint = useMemo(() => {
    const hasText = pageHasIndexableText(doc.path, indexPage, doc.pages);
    if (hasText) {
      if (indexState?.status === "done" && indexState.source === "vision") {
        return t("preview.indexedVision");
      }
      return null;
    }
    if (indexState?.status === "indexing") return t("preview.indexing");
    if (indexState?.status === "failed") {
      let hint: string;
      switch (indexState.failureReason) {
        case "vision_failed":
          hint = t("preview.indexFailedNeedVision");
          break;
        case "insufficient_text":
          hint = t("preview.indexFailedInsufficient");
          break;
        default:
          hint = t("preview.indexFailedUnknown");
      }
      const detail = sanitizeIndexErrorDetail(indexState.error);
      if (detail && detail !== indexState.failureReason) {
        return `${hint} · ${t(`preview.indexError.${detail}`)}`;
      }
      return hint;
    }
    if (pageTextLen === 0) return t("preview.indexing");
    return null;
  }, [doc.path, doc.pages, indexPage, indexState, pageTextLen, t]);

  const indexHintActionable =
    indexState?.status === "failed" &&
    indexState.failureReason === "vision_failed" &&
    !!onOpenAiSettings;

  const showRetryOnVisionFailed =
    indexState?.status === "failed" && indexState.failureReason === "vision_failed";

  const indexFailed = indexState?.status === "failed";

  const retryIndex = () => {
    clearPageIndexState(doc.path, indexPage);
    indexPageInBackground(doc.path, indexPage);
  };

  const rasterHeavy =
    doc.kind === "pdf" && isRasterHeavyPage(doc.pages[page - 1]?.text.trim().length ?? 0);
  const rasterHint = rasterHeavy ? t("preview.rasterHint") : null;
  const totalPages = doc.kind === "pdf" ? doc.totalPages : 1;

  // One function for every page rather than a closure per page: the scroller
  // re-renders on every frame of a scroll, and a fresh function each time would
  // make `PageSlot`'s memo miss, re-reconciling every mounted page and all four
  // of its overlay layers sixty times a second.
  const renderOverlays = useCallback(
    (slotPage: number) => (
      <>
        {searchHit?.page === slotPage && (
          <SearchHighlight path={doc.path} page={slotPage} query={searchHit.query} />
        )}
        <RegionSelectLayer
          active={regionMode}
          onRegion={(rect, pageBox) => {
            const run = quoteRun.current;
            void (async () => {
              try {
                const geometry = await getPageGeometry(doc.path, slotPage);
                // The reader can scroll on while the geometry is in flight, but
                // the page a region belongs to is the one it was drawn on,
                // which is fixed at this point.
                if (quoteRun.current !== run) return;
                const pdfRect = clientRectToPageRect(rect, pageBox, geometry);
                let text = "";
                try {
                  text = regionSnapshot(await extractRegion(doc.path, slotPage, pdfRect));
                } catch {
                  // A region with no readable text is normal on a scan;
                  // the rectangle is what locates the mark.
                }
                if (quoteRun.current !== run) return;
                const mark = addMark(doc.path, {
                  page: slotPage,
                  rects: [pdfRect],
                  text,
                  stamp: doc.stamp ?? "",
                  kind: "region",
                });
                if (mark) setSelectedMarkId(mark.id);
                else showToast(t("marks.capReached"), "error");
              } catch {
                // Nothing to place the mark against.
              }
            })();
          }}
        />
        <MarkLayer
          path={doc.path}
          page={slotPage}
          revision={markRevision}
          selectedId={selectedMarkId}
          onSelect={setSelectedMarkId}
        />
        {doc.links && doc.links.length > 0 && (
          <LinkLayer
            path={doc.path}
            page={slotPage}
            links={doc.links}
            onActivate={setPendingLink}
          />
        )}
      </>
    ),
    [doc.path, doc.links, doc.stamp, searchHit, regionMode, markRevision, selectedMarkId, showToast, t],
  );

  const canvasBody = (
    <>
      {indexHint &&
        (indexFailed ? (
          // A failed index always offers Retry (for vision_failed — often a
          // transient network error) alongside Settings when actionable. The
          // old settings-only branch hid Retry whenever onOpenAiSettings was
          // present, i.e. always in production.
          <div className="preview-index-badge-row" aria-live="polite">
            <div className="preview-index-badge">{indexHint}</div>
            {showRetryOnVisionFailed && (
              <button type="button" className="preview-index-retry-btn" onClick={retryIndex}>
                {t("preview.retryIndex")}
              </button>
            )}
            {indexHintActionable && onOpenAiSettings && (
              <button
                type="button"
                className="preview-index-retry-btn"
                onClick={onOpenAiSettings}
              >
                {t("settings.title")}
              </button>
            )}
          </div>
        ) : (
          <div className="preview-index-badge" aria-live="polite">
            {indexHint}
          </div>
        ))}
      {rasterHint && <p className="preview-raster-hint">{rasterHint}</p>}
      {doc.kind === "pdf" ? (
        <PageScroller
          doc={doc}
          page={page}
          onPageChange={onPageChange}
          zoom={viewer.zoom}
          quality={viewer.quality}
          containerRef={bindScroller}
          renderOverlays={renderOverlays}
        />
      ) : (
        <div className="preview-page-frame">
          <img src={convertFileSrc(doc.path)} alt={doc.name} className="preview-image" />
        </div>
      )}
    </>
  );

  const toolbar = (
    <PreviewToolbar
      filename={doc.name}
      page={doc.kind === "pdf" ? page : 1}
      totalPages={totalPages}
      zoom={viewer.zoom}
      onZoomChange={viewer.handleZoomChange}
      onZoomIn={viewer.zoomIn}
      onZoomOut={viewer.zoomOut}
      zoomDisabled={doc.kind === "image"}
      onPageChange={onPageChange}
      thumbsVisible={thumbsVisible}
      onToggleThumbs={() => setThumbsVisible((v) => !v)}
      regionMode={regionMode}
      onToggleRegionMode={
        doc.kind === "pdf" ? () => setRegionMode((v) => !v) : undefined
      }
    />
  );

  if (doc.kind === "image") {
    return (
      <div className="preview-panel">
        <DocumentSearch
        doc={doc}
        onJumpToPage={(target, query) => {
          onPageChange(target);
          setSearchHit(query ? { page: target, query } : null);
        }}
      />
        {toolbar}
        <div className="preview-canvas-wrap image-wrap" onClick={viewer.focusPreview}>
          {canvasBody}
        </div>
      </div>
    );
  }

  // Recovered from the page text when the document was opened; a document with
  // no headings simply has no tab to switch to.
  const outline = usableOutline(doc.outline, doc.totalPages);
  const showOutline = sidebarTab === "outline" && outline.length > 0;
  const showMarks = sidebarTab === "marks";
  const marks = (void markRevision, getMarks(doc.path));
  const selectedMark = marks.find((m) => m.id === selectedMarkId) ?? null;
  // Marks made against a different version of this file. Unlike the page index,
  // which is discarded when the file changes because it can be recomputed, the
  // reader's own marks are kept — the rectangles may now point at the wrong
  // place, but only the reader can judge that, and the snapshot still says what
  // was marked.
  const staleMarks = marksAreStale(doc.path, doc.stamp ?? "");
  const sidebarTabs = (
    <div className="sidebar-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={!showOutline}
        className={`sidebar-tab ${!showOutline ? "active" : ""}`}
        onClick={() => setSidebarTab("pages")}
      >
        {t("preview.pages")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={showOutline}
        // The tabs are always shown now that marks need reaching, so a document
        // without a recovered outline disables this one rather than offering a
        // tab that silently falls back to pages.
        disabled={outline.length === 0}
        className={`sidebar-tab ${showOutline ? "active" : ""}`}
        onClick={() => setSidebarTab("outline")}
      >
        {t("preview.outline")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={showMarks}
        className={`sidebar-tab ${showMarks ? "active" : ""}`}
        onClick={() => setSidebarTab("marks")}
      >
        {t("preview.marks")}
      </button>
    </div>
  );

  return (
    <div className="preview-panel preview-with-thumbs">
      <DocumentSearch
        doc={doc}
        onJumpToPage={(target, query) => {
          onPageChange(target);
          setSearchHit(query ? { page: target, query } : null);
        }}
      />

      {thumbsVisible &&
        (showMarks ? (
          <MarkSidebar
            path={doc.path}
            revision={markRevision}
            currentPage={page}
            selectedId={selectedMarkId}
            stale={staleMarks}
            tabs={sidebarTabs}
            onClose={() => setThumbsVisible(false)}
            onSelect={(target, id) => {
              onPageChange(target);
              setSelectedMarkId(id);
            }}
            onAsk={
              onAskAboutSelection
                ? (mark) => {
                    // The page number goes in the text because that is what the
                    // assistant can act on: it turns "this mark" into a page it
                    // can read. A region mark often has no words at all, so it
                    // says where rather than what.
                    const text = mark.text.trim();
                    onAskAboutSelection(
                      text
                        ? t("marks.askQuoted", { page: mark.page, text })
                        : t("marks.askRegion", { page: mark.page }),
                    );
                  }
                : undefined
            }
          />
        ) : showOutline ? (
          <OutlineSidebar
            outline={outline}
            currentPage={page}
            tabs={sidebarTabs}
            onClose={() => setThumbsVisible(false)}
            onPageSelect={onPageChange}
          />
        ) : (
          <ThumbnailSidebar
            path={doc.path}
            totalPages={doc.totalPages}
            currentPage={page}
            tabs={sidebarTabs}
            onToggle={() => setThumbsVisible(false)}
            onPageSelect={onPageChange}
          />
        ))}

      <div className="preview-main">
        {toolbar}
        <div className="preview-canvas-wrap" onClick={viewer.focusPreview}>
          {canvasBody}
        </div>
      </div>
      {(askButton || markButton) && askSel && (
        // One anchored row: the buttons sit next to each other because they are
        // laid out, not because the second is nudged by the first's width in
        // one particular language.
        <div className="selection-actions" style={{ left: askSel.x, top: askSel.y }}>
          {askButton}
          {markButton}
        </div>
      )}
      {selectedMark && (
        <MarkNote
          path={doc.path}
          mark={selectedMark}
          currentStamp={doc.stamp ?? ""}
          onClose={() => setSelectedMarkId(null)}
        />
      )}

      <ConfirmOverlay
        open={pendingLink !== null}
        message={t("preview.openLinkConfirm", { url: displayUrl(pendingLink ?? "") })}
        confirmLabel={t("preview.openLinkAction")}
        onConfirm={() => {
          const url = pendingLink;
          setPendingLink(null);
          if (url) void openUrl(url);
        }}
        onCancel={() => setPendingLink(null)}
      />
    </div>
  );
}

export const PreviewPane = memo(PreviewPaneInner);
