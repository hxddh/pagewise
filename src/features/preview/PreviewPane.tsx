import { convertFileSrc } from "@tauri-apps/api/core";
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
import type { LoadedDocument } from "../../lib/types";
import { PreviewToolbar } from "../../components/PreviewToolbar";
import { ThumbnailSidebar } from "../../components/ThumbnailSidebar";
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

  const viewer = usePdfViewer({ doc, page, onPageChange, prefsRevision });
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
          onAskAboutSelection(askSel.text);
          clearAskSel();
          window.getSelection()?.removeAllRanges();
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
        (indexHintActionable ? (
          <button
            type="button"
            className="preview-index-badge preview-index-badge-action"
            aria-live="polite"
            onClick={onOpenAiSettings}
          >
            {indexHint}
          </button>
        ) : indexFailed ? (
          <div className="preview-index-badge-row" aria-live="polite">
            <div className="preview-index-badge">{indexHint}</div>
            {(showRetryOnVisionFailed || indexHintActionable) && (
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
        <DocumentSearch doc={doc} onJumpToPage={onPageChange} />
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

  return (
    <div className="preview-panel preview-with-thumbs">
      <DocumentSearch doc={doc} onJumpToPage={onPageChange} />

      {thumbsVisible && (
        <ThumbnailSidebar
          path={doc.path}
          totalPages={doc.totalPages}
          currentPage={page}
          collapsed={false}
          onToggle={() => setThumbsVisible(false)}
          onPageSelect={onPageChange}
        />
      )}

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
    </div>
  );
}

export const PreviewPane = memo(PreviewPaneInner);
