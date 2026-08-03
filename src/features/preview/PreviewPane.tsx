import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ConfirmOverlay } from "../../components/overlays/ConfirmOverlay";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { usePageIndexStatus } from "../../hooks/usePageIndexStatus";
import { getPageIndexState, clearPageIndexState } from "../../lib/index-events";
import { sanitizeIndexErrorDetail } from "../../lib/index-error-display";
import { getPageTextLen, pageHasIndexableText } from "../../lib/doc-text";
import { isRasterHeavyPage } from "../../lib/pdf";
import { indexPageInBackground } from "../../document/index-queue";
import { usePdfViewer } from "./usePdfViewer";
import { useAskSelection } from "./useAskSelection";
import { selectionQuote } from "./selection-quote";
import { SearchHighlight } from "./SearchHighlight";
import { LinkLayer } from "./LinkLayer";
import { displayUrl } from "../../lib/safe-link";
import type { LoadedDocument } from "../../lib/types";
import { PreviewToolbar } from "../../components/PreviewToolbar";
import { ThumbnailSidebar } from "../../components/ThumbnailSidebar";
import { OutlineSidebar } from "../../components/OutlineSidebar";
import { usableOutline } from "../../lib/outline-nav";
import { DocumentSearch } from "../../components/DocumentSearch";

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
  const [thumbsVisible, setThumbsVisible] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<"pages" | "outline">("pages");
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
  }, [doc.path, page]);
  const [askSel, clearAskSel] = useAskSelection(
    viewer.textLayerRef,
    !!onAskAboutSelection && doc.kind === "pdf",
  );

  const askButton =
    askSel && onAskAboutSelection ? (
      <button
        type="button"
        className="ask-selection-btn"
        style={{ left: askSel.x, top: askSel.y }}
        // Keep the selection alive through the click.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const box = viewer.textLayerRef.current?.getBoundingClientRect() ?? null;
          const selectionRect = askSel.rect;
          const run = quoteRun.current;
          clearAskSel();
          window.getSelection()?.removeAllRanges();
          void selectionQuote(doc.path, page, askSel.text, selectionRect, box).then(
            (quote) => {
              // Reading the region is a round trip, and the user can turn the
              // page or open another document while it is in flight. Dropping
              // a superseded result keeps a quote from the old page out of the
              // new one's composer.
              if (quoteRun.current !== run) return;
              onAskAboutSelection(quote);
            },
          );
        }}
      >
        {t("preview.askAboutSelection")}
      </button>
    ) : null;

  const indexPage = doc.kind === "pdf" ? page : 1;
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
      {viewer.renderError && (
        <div className="preview-error-banner" role="alert">
          {viewer.renderError}
        </div>
      )}
      {viewer.showLoading && (
        <div className="preview-loading" aria-live="polite">
          <span className="preview-loading-spinner" aria-hidden />
          {t("preview.rendering")}
        </div>
      )}
      {rasterHint && <p className="preview-raster-hint">{rasterHint}</p>}
      {doc.kind === "pdf" && totalPages > 1 && (
        <>
          <button
            type="button"
            className="page-edge page-edge-left"
            onClick={viewer.prevPage}
            disabled={page <= 1}
            aria-label={t("preview.previousPage")}
            tabIndex={0}
          />
          <button
            type="button"
            className="page-edge page-edge-right"
            onClick={viewer.nextPage}
            disabled={page >= totalPages}
            aria-label={t("preview.nextPage")}
            tabIndex={0}
          />
        </>
      )}
      <div
        className={`preview-page-frame${viewer.pageTurnAnim ? ` page-turn-${viewer.pageTurnAnim}` : ""}`}
      >
        {doc.kind === "pdf" ? (
          <>
            <canvas ref={viewer.canvasRef} className="preview-canvas" />
            <div
              ref={viewer.textLayerRef}
              className={`pdf-text-layer${viewer.textLayerActive ? " pdf-text-layer-active" : ""}`}
              aria-hidden={!viewer.textLayerActive}
            />
            {searchHit?.page === page && (
              <SearchHighlight path={doc.path} page={page} query={searchHit.query} />
            )}
            {doc.links && doc.links.length > 0 && (
              <LinkLayer
                path={doc.path}
                page={page}
                links={doc.links}
                onActivate={setPendingLink}
              />
            )}
          </>
        ) : (
          <img src={convertFileSrc(doc.path)} alt={doc.name} className="preview-image" />
        )}
      </div>
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
        <div
          className="preview-canvas-wrap image-wrap preview-focusable"
          ref={viewer.wrapRef}
          tabIndex={0}
          onClick={viewer.focusPreview}
        >
          {canvasBody}
        </div>
      </div>
    );
  }

  // Recovered from the page text when the document was opened; a document with
  // no headings simply has no tab to switch to.
  const outline = usableOutline(doc.outline, doc.totalPages);
  const showOutline = sidebarTab === "outline" && outline.length > 0;
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
        className={`sidebar-tab ${showOutline ? "active" : ""}`}
        onClick={() => setSidebarTab("outline")}
      >
        {t("preview.outline")}
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
        (showOutline ? (
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
            tabs={outline.length > 0 ? sidebarTabs : undefined}
            onToggle={() => setThumbsVisible(false)}
            onPageSelect={onPageChange}
          />
        ))}

      <div className="preview-main">
        {toolbar}
        <div
          className="preview-canvas-wrap preview-focusable"
          ref={viewer.wrapRef}
          tabIndex={0}
          onClick={viewer.focusPreview}
        >
          {canvasBody}
        </div>
      </div>
      {askButton}

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
