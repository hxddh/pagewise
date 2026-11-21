import { memo, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import {
  buildScaleKey,
  effectiveRenderQuality,
  getPageGeometry,
  isRasterHeavyPage,
  renderPageToCanvas,
  renderTextLayer,
  tryApplyCachedPage,
} from "../../lib/pdf";
import { getPageTextLen } from "../../lib/doc-text";
import { labelForPage } from "../../lib/page-labels";
import { getCachedOcrWords } from "../../lib/ocr/ocr-service";
import { onOcrTextReplaced } from "../../lib/ocr/ocr-events";
import { hasNativeTextSpans, populateOcrTextLayer } from "../../lib/ocr/ocr-text-layer";
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
  /** True during continuous trackpad pinch-zoom; stretches existing canvas until settled. */
  pinching?: boolean;
  /** Container width, which is what a fit-width scale key is keyed on. */
  containerWidth: number;
  /**
   * The margin the column reserves, which a fit-width key names as well: the
   * scale it produced is what decides the bitmap's size.
   */
  reservedWidth: number;
  /** The zoom mode, for the same reason. */
  zoom: import("../../lib/zoom").ZoomMode;
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
  pinching = false,
  containerWidth,
  reservedWidth,
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
  const stamp = doc.stamp ?? "";
  const textLen = getPageTextLen(path, page, doc.pages);

  useEffect(() => {
    // While actively pinching an already-drawn page, CSS hardware-stretches the
    // existing canvas to 100%×100% at 120fps; crisp HiDPI rasterization runs
    // once the gesture settles (27.0).
    if (pinching && drawn) return;
    let cancelled = false;
    const isStale = () => cancelled;
    // A scanned page is a photograph: rasterizing it crisply costs a lot and
    // shows nothing more. Scrolling fast is the same trade for a moment.
    const raster = isRasterHeavyPage(textLen) || hurried || pinching;
    const effective = effectiveRenderQuality(quality, raster);
    const scaleKey = buildScaleKey(zoom, containerWidth, scale, reservedWidth);

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
  }, [path, stamp, page, scale, quality, hurried, pinching, drawn, zoom, containerWidth, reservedWidth, textLen, t]);

  const [ocrEpoch, setOcrEpoch] = useState(0);
  useEffect(() => {
    return onOcrTextReplaced((changedPath) => {
      if (changedPath === path) setOcrEpoch((n) => n + 1);
    });
  }, [path]);

  const wantTextLayer = drawn && !hurried && !pinching && (textLen > 0 || (getCachedOcrWords(path, page)?.length ?? 0) > 0);

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
        if (cancelled) return;
        if (!hasNativeTextSpans(container)) {
          const ocrWords = getCachedOcrWords(path, page);
          if (ocrWords && ocrWords.length > 0 && !cancelled) {
            let geometry: Awaited<ReturnType<typeof getPageGeometry>> | undefined;
            try {
              geometry = await getPageGeometry(path, page);
            } catch {
              // Fallback to coordinate inference if geometry cannot be fetched.
            }
            if (!cancelled) {
              populateOcrTextLayer(container, ocrWords, width, height, { geometry });
            }
          }
        }
        if (!cancelled) setTextLayerActive(true);
      } catch {
        // A page reads fine without a selectable text layer.
      }
    })();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [wantTextLayer, path, stamp, page, scale, width, height, ocrEpoch]);

  const printed = labelForPage(doc.pageLabels ?? null, page);

  return (
    <div
      className="pdf-page-slot"
      style={{ top, width, height }}
      data-page={page}
      aria-label={t("preview.pageHit", { page })}
    >
      <div className="pdf-page-clip">
        <canvas
          ref={canvasRef}
          className={pinching ? "preview-canvas preview-canvas-pinching" : "preview-canvas"}
        />
        <div
          ref={textLayerRef}
          className={`pdf-text-layer${textLayerActive ? " pdf-text-layer-active" : ""}`}
          aria-hidden={!textLayerActive}
        />
        {renderOverlays?.(page, { textLayerActive })}
        {error && <div className="pdf-page-error">{error}</div>}
      </div>
      <span className="pdf-page-number" aria-hidden>
        {printed ? `${printed} · ${page}` : page}
      </span>
    </div>
  );
});
