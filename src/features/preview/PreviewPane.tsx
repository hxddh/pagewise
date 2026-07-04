import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { usePageIndexStatus } from "../../hooks/usePageIndexStatus";
import { getPageIndexState } from "../../lib/index-events";
import { isRasterHeavyPage } from "../../lib/pdf";
import { indexPageInBackground, MIN_INDEX_CHARS } from "../../lib/vision-index";
import { usePdfViewer } from "./usePdfViewer";
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
}

export function PreviewPane({
  doc,
  page,
  onPageChange,
  prefsRevision = 0,
  onOpenAiSettings,
}: PreviewPaneProps) {
  const { t } = useI18n();
  const [thumbsVisible, setThumbsVisible] = useState(false);

  const viewer = usePdfViewer({ doc, page, onPageChange, prefsRevision });

  const indexPage = doc.kind === "pdf" ? page : 1;
  const indexState = usePageIndexStatus(doc.path, indexPage);
  const pageTextLen = doc.pages[indexPage - 1]?.text.trim().length ?? 0;

  useEffect(() => {
    if (pageTextLen >= MIN_INDEX_CHARS) return;
    const state = getPageIndexState(doc.path, indexPage);
    if (state?.status === "indexing" || state?.status === "done" || state?.status === "failed") {
      return;
    }
    indexPageInBackground(doc.path, indexPage, doc.kind);
  }, [doc.path, doc.kind, indexPage, pageTextLen]);

  const indexHint = useMemo(() => {
    if (pageTextLen >= MIN_INDEX_CHARS) return null;
    if (indexState?.status === "indexing") return t("preview.indexing");
    if (indexState?.status === "done" && indexState.source === "vision") {
      return t("preview.indexedVision");
    }
    if (indexState?.status === "done" && indexState.source === "ocr") {
      return t("preview.indexedOcr");
    }
    if (indexState?.status === "failed") {
      switch (indexState.failureReason) {
        case "need_vision":
          return t("preview.indexFailedNeedVision");
        case "ocr_unavailable":
          return t("preview.indexFailedOcrMissing");
        case "vision_failed":
          return t("preview.indexFailedVision");
        default:
          return t("preview.indexFailedUnknown");
      }
    }
    if (pageTextLen === 0) return t("preview.indexing");
    return null;
  }, [pageTextLen, indexState, t]);

  const indexHintActionable =
    indexState?.status === "failed" &&
    (indexState.failureReason === "need_vision" ||
      indexState.failureReason === "vision_failed") &&
    !!onOpenAiSettings;

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
        ) : (
          <div className="preview-index-badge" aria-live="polite">
            {indexHint}
          </div>
        ))}
      {viewer.renderError && (
        <div className="preview-error-banner" role="alert">
          {t("preview.renderFailed")}
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
            tabIndex={-1}
          />
          <button
            type="button"
            className="page-edge page-edge-right"
            onClick={viewer.nextPage}
            disabled={page >= totalPages}
            aria-label={t("preview.nextPage")}
            tabIndex={-1}
          />
        </>
      )}
      <div
        className={`preview-page-frame${viewer.pageTurnAnim ? ` page-turn-${viewer.pageTurnAnim}` : ""}`}
      >
        {doc.kind === "pdf" ? (
          <>
            <canvas ref={viewer.canvasRef} className="preview-canvas" />
            {viewer.showTextLayer && (
              <div ref={viewer.textLayerRef} className="pdf-text-layer" />
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
    </div>
  );
}
