import { memo, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import {
  buildScaleKey,
  effectiveRenderQuality,
  isRasterHeavyPage,
  renderPageToCanvas,
  renderTextLayer,
  tryApplyCachedPage,
} from "../../lib/pdf";
import { getPageTextLen } from "../../lib/doc-text";
import type { LoadedDocument, PreviewQuality } from "../../lib/types";

export interface PageSlotProps {
  doc: LoadedDocument;
  /** 1-based. */
  page: number;
  /** Absolute position and size within the scrolling column, in CSS px. */
  top: number;
  width: number;
  height: number;
  scale: number;
  quality: PreviewQuality;
  /** True while the reader is scrolling fast; drops to a cheaper raster. */
  hurried: boolean;
  /** Container width, which is what a fit-width scale key is keyed on. */
  containerWidth: number;
  /** The zoom mode, for the same reason. */
  zoom: "fit-width" | number;
  /**
   * Overlays for this page — highlights, marks, links, region select.
   *
   * Taken as one function for the whole document rather than a per-page
   * closure: a new closure on every scroll frame would make `memo` below a
   * decoration, and every mounted page would re-reconcile 60 times a second.
   */
  renderOverlays?: (page: number, state: { textLayerActive: boolean }) => React.ReactNode;
}

/**
 * One page in the scrolling column.
 *
 * Each page owns its canvas, its text layer and its overlays. In the
 * page-at-a-time viewer there was exactly one of each and they were positioned
 * against "the page"; with every page on one surface, "the page" is whichever
 * one the overlay belongs to, so the ownership moves down here.
 */
export const PageSlot = memo(function PageSlot({
  doc,
  page,
  top,
  width,
  height,
  scale,
  quality,
  hurried,
  containerWidth,
  zoom,
  renderOverlays,
}: PageSlotProps) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [textLayerActive, setTextLayerActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawn, setDrawn] = useState(false);

  const path = doc.path;
  const textLen = getPageTextLen(path, page, doc.pages);

  useEffect(() => {
    let cancelled = false;
    const isStale = () => cancelled;
    // A scanned page is a photograph: rasterizing it crisply costs a lot and
    // shows nothing more. Scrolling fast is the same trade for a moment.
    const raster = isRasterHeavyPage(textLen) || hurried;
    const effective = effectiveRenderQuality(quality, raster);
    const scaleKey = buildScaleKey(zoom, containerWidth, scale);

    void (async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      // A page already rasterized at this scale paints from cache without a
      // round trip, which is what keeps a fast scroll from flashing blank.
      const cacheHit = tryApplyCachedPage(path, page, scaleKey, effective, canvas);
      if (cacheHit) {
        setDrawn(true);
        setError(null);
      }
      try {
        if (!cacheHit) {
          const result = await renderPageToCanvas(
            path,
            page,
            canvas,
            scale,
            "high",
            effective,
            scaleKey,
            isStale,
          );
          if (result.cancelled && isStale()) return;
          if (isStale()) return;
          setDrawn(true);
        }
        setError(null);
      } catch (e) {
        if (!isStale()) setError(e instanceof Error ? e.message : t("preview.renderFailed"));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path, page, scale, quality, hurried, zoom, containerWidth, textLen, t]);

  // The text layer is what makes a page selectable. It is skipped on pages with
  // no extracted text — there would be nothing in it — and while scrolling
  // fast, where building it for pages about to leave the screen is wasted work.
  const wantTextLayer = drawn && !hurried && textLen > 0;

  useEffect(() => {
    if (!wantTextLayer) {
      setTextLayerActive(false);
      return;
    }
    const container = textLayerRef.current;
    if (!container) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void (async () => {
      try {
        cleanup = await renderTextLayer(path, page, scale, container, () => cancelled);
        if (!cancelled) setTextLayerActive(true);
      } catch {
        // A page reads fine without a selectable text layer.
      }
    })();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [wantTextLayer, path, page, scale]);

  return (
    <div
      className="pdf-page-slot"
      style={{ top, width, height }}
      data-page={page}
      aria-label={t("preview.pageHit", { page })}
    >
      <canvas ref={canvasRef} className="preview-canvas" />
      <div
        ref={textLayerRef}
        className={`pdf-text-layer${textLayerActive ? " pdf-text-layer-active" : ""}`}
        aria-hidden={!textLayerActive}
      />
      {renderOverlays?.(page, { textLayerActive })}
      {error && <div className="pdf-page-error">{error}</div>}
      <span className="pdf-page-number" aria-hidden>
        {page}
      </span>
    </div>
  );
});
