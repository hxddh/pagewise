import { convertFileSrc } from "@tauri-apps/api/core";
import { memo, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { usePageIndexStatus } from "../../hooks/usePageIndexStatus";
import { getPageIndexState, clearPageIndexState } from "../../lib/index-events";
import { getPageTextLen, pageHasIndexableText } from "../../lib/doc-text";
import { isRasterHeavyPage } from "../../lib/pdf";
import { indexPageInBackground } from "../../lib/vision-index";
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

function PreviewPaneInner({
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
  const pageTextLen = getPageTextLen(doc.path, indexPage, doc.pages);

  useEffect(() => {
    if (pageHasIndexableText(doc.path, indexPage, doc.pages)) {
      if (getPageIndexState(doc.path, indexPage)?.status === "failed") {
        clearPageIndexState(doc.path, indexPage);
      }
      return;
    }
    const state = getPageIndexState(doc.path, indexPage);
    if (state?.status === "indexing" || state?.status === "done" || state?.status === "failed") {
      return;
    }
    indexPageInBackground(doc.path, indexPage, doc.kind);
  }, [doc.path, doc.kind, indexPage, pageTextLen, doc.pages]);

  const indexHint = useMemo(() => {
    if (pageHasIndexableText(doc.path, indexPage, doc.pages)) return null;
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
    </div>
  );
}

export const PreviewPane = memo(PreviewPaneInner);
