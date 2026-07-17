import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  buildScaleKey,
  clearPageBitmapCache,
  effectiveRenderQuality,
  hasPageCache,
  isRasterHeavyPage,
  prefetchPage,
  renderPageToCanvas,
  renderTextLayer,
  resolveFitWidthScale,
  tryApplyCachedPage,
} from "../../lib/pdf";
import { loadPreferences } from "../../lib/preferences";
import { useI18n } from "../../i18n";
import { registerPreviewActions } from "../../lib/preview-actions";
import { isOverlayOpen, isTypingTarget } from "../../lib/shortcut-guards";
import { getPageTextLen } from "../../lib/doc-text";
import type { LoadedDocument, PreviewQuality } from "../../lib/types";
import { isSameZoom, stepZoom, type ZoomMode } from "../../lib/zoom";
import {
  isPageVerticallyScrollable,
  normalizeWheelDelta,
  shouldScrollWithinPage,
  WHEEL_GESTURE,
  wheelFlipReady,
} from "../../lib/wheel-gesture";

const ZOOM_KEY = "pagewise.zoom";
const KEY_PAGE_COOLDOWN_MS = 320;
const NAV_BURST_MS = 400;
const NAV_IDLE_MS = 350;
const LOADING_DELAY_MS = 80;

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

function loadZoom(): ZoomMode {
  const raw = localStorage.getItem(ZOOM_KEY);
  if (raw === "fit-width") return "fit-width";
  const n = raw ? parseFloat(raw) : NaN;
  if (!Number.isFinite(n)) return "fit-width";
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, n));
}

interface UsePdfViewerOptions {
  doc: LoadedDocument;
  page: number;
  onPageChange: (page: number) => void;
  prefsRevision?: number;
}

export function usePdfViewer({
  doc,
  page,
  onPageChange,
  prefsRevision = 0,
}: UsePdfViewerOptions) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const wrapNodeRef = useRef<HTMLDivElement | null>(null);
  const wrapCleanupRef = useRef<(() => void) | null>(null);

  const [zoom, setZoom] = useState<ZoomMode>(loadZoom);
  const [refitToken, setRefitToken] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [showLoading, setShowLoading] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [userQuality, setUserQuality] = useState<PreviewQuality>("crisp");
  const [textLayerActive, setTextLayerActive] = useState(false);
  const [navBurst, setNavBurst] = useState(false);
  const [pageTurnAnim, setPageTurnAnim] = useState<"next" | "prev" | null>(null);

  const lastNumericRef = useRef(1);
  const pageRef = useRef(page);
  const totalRef = useRef(doc.kind === "pdf" ? doc.totalPages : 1);
  const scrollToEndRef = useRef(false);
  const lastWheelFlipAtRef = useRef(0);
  const keyPageLockUntilRef = useRef(0);
  const loadingTimerRef = useRef<number | undefined>(undefined);
  const navIdleTimerRef = useRef<number | undefined>(undefined);
  const lastNavAtRef = useRef(0);
  const navBurstCountRef = useRef(0);
  const renderGenRef = useRef(0);
  const zoomRef = useRef(zoom);
  const flipRef = useRef<(dir: -1 | 1) => void>(() => {});
  const resizeRafRef = useRef<number | undefined>(undefined);
  const pendingWidthRef = useRef(0);

  zoomRef.current = zoom;
  pageRef.current = page;
  totalRef.current = doc.kind === "pdf" ? doc.totalPages : 1;

  const docPath = doc.path;
  const docTotalPages = doc.kind === "pdf" ? doc.totalPages : 1;
  const currentPageTextLen = getPageTextLen(docPath, page, doc.pages);

  useEffect(() => {
    loadPreferences().then((p) => setUserQuality(p.previewQuality));
  }, [prefsRevision]);

  useEffect(() => {
    setZoom("fit-width");
    // Doc-switch PDF cache invalidation is owned by useDocumentWorkspace (clearPdfCache).
  }, [docPath]);

  useEffect(() => {
    // Quality only affects rendered bitmaps — drop those and re-render, but keep
    // the loaded pdf.js document and cached PDF bytes to avoid a full reload.
    clearPageBitmapCache();
  }, [userQuality]);

  useEffect(() => {
    const initial = loadZoom();
    if (typeof initial === "number") lastNumericRef.current = initial;
  }, []);

  const scheduleWidthUpdate = useCallback((width: number) => {
    pendingWidthRef.current = width;
    if (resizeRafRef.current !== undefined) return;
    resizeRafRef.current = requestAnimationFrame(() => {
      resizeRafRef.current = undefined;
      setViewportWidth((prev) => {
        const next = pendingWidthRef.current;
        return Math.abs(prev - next) >= 32 ? next : prev;
      });
    });
  }, []);

  const bindWrap = useCallback(
    (node: HTMLDivElement | null) => {
      wrapCleanupRef.current?.();
      wrapCleanupRef.current = null;
      wrapNodeRef.current = node;

      if (!node) return;

      scheduleWidthUpdate(node.clientWidth);
      const ro = new ResizeObserver(() => scheduleWidthUpdate(node.clientWidth));
      ro.observe(node);

      if (doc.kind !== "pdf" || docTotalPages <= 1) {
        wrapCleanupRef.current = () => ro.disconnect();
        return;
      }

      let accum = 0;
      let accumSign = 0;
      let lastWheelAt = 0;
      let gestureTimer: number | undefined;

      const resetAccum = () => {
        accum = 0;
        accumSign = 0;
      };

      const commitGesture = () => {
        gestureTimer = undefined;
        const now = Date.now();
        if (now - lastWheelFlipAtRef.current < WHEEL_GESTURE.minFlipGapMs) {
          resetAccum();
          return;
        }

        const fitWidth = zoomRef.current === "fit-width";
        const threshold = fitWidth ? WHEEL_GESTURE.thresholdFit : WHEEL_GESTURE.thresholdEdge;
        const total = Math.abs(accum);
        const sign = accumSign;
        resetAccum();

        if (total < threshold) return;

        if (sign > 0 && pageRef.current < totalRef.current) {
          lastWheelFlipAtRef.current = now;
          flipRef.current(1);
        } else if (sign < 0 && pageRef.current > 1) {
          lastWheelFlipAtRef.current = now;
          flipRef.current(-1);
        }
      };

      const onWheel = (e: WheelEvent) => {
        if (isOverlayOpen()) return;

        const dy = normalizeWheelDelta(e, 16, node.clientHeight);
        if (dy === 0) return;

        const fitWidth = zoomRef.current === "fit-width";
        const atTop = node.scrollTop <= 1;
        const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 2;
        const scrollable = isPageVerticallyScrollable(node.scrollHeight, node.clientHeight);

        if (shouldScrollWithinPage(dy, atTop, atBottom, scrollable)) {
          resetAccum();
          window.clearTimeout(gestureTimer);
          return;
        }

        const now = Date.now();
        if (now - lastWheelAt > WHEEL_GESTURE.accumIdleMs) resetAccum();
        lastWheelAt = now;

        const sign = Math.sign(dy);
        if (accumSign !== 0 && sign !== accumSign) resetAccum();
        accumSign = sign;
        accum += dy;

        const threshold = fitWidth ? WHEEL_GESTURE.thresholdFit : WHEEL_GESTURE.thresholdEdge;
        window.clearTimeout(gestureTimer);
        if (wheelFlipReady(accum, threshold)) {
          e.preventDefault();
          commitGesture();
        } else {
          gestureTimer = window.setTimeout(commitGesture, WHEEL_GESTURE.endMs);
          if (Math.abs(accum) >= threshold * 0.35) e.preventDefault();
        }
      };

      node.addEventListener("wheel", onWheel, { passive: false });
      wrapCleanupRef.current = () => {
        ro.disconnect();
        node.removeEventListener("wheel", onWheel);
        window.clearTimeout(gestureTimer);
      };
    },
    [doc.kind, docPath, docTotalPages, scheduleWidthUpdate],
  );

  useEffect(() => () => wrapCleanupRef.current?.(), []);

  const extendNavBurst = useCallback(() => {
    setNavBurst(true);
    window.clearTimeout(navIdleTimerRef.current);
    navIdleTimerRef.current = window.setTimeout(() => {
      setNavBurst(false);
      navBurstCountRef.current = 0;
    }, NAV_IDLE_MS);
  }, []);

  const noteNavigation = useCallback(() => {
    const now = Date.now();
    if (now - lastNavAtRef.current < NAV_BURST_MS) {
      navBurstCountRef.current += 1;
    } else {
      navBurstCountRef.current = 1;
    }
    lastNavAtRef.current = now;
    if (navBurstCountRef.current >= 2) extendNavBurst();
  }, [extendNavBurst]);

  const goToPage = useCallback(
    (next: number) => {
      const clamped = Math.min(totalRef.current, Math.max(1, next));
      if (clamped !== pageRef.current) {
        noteNavigation();
        onPageChange(clamped);
      }
    },
    [noteNavigation, onPageChange],
  );

  const prevPage = useCallback(() => {
    if (pageRef.current <= 1) return;
    scrollToEndRef.current = true;
    goToPage(pageRef.current - 1);
  }, [goToPage]);

  const nextPage = useCallback(() => {
    if (pageRef.current >= totalRef.current) return;
    goToPage(pageRef.current + 1);
    const el = wrapNodeRef.current;
    if (el) el.scrollTop = 0;
  }, [goToPage]);

  const flipInstant = useCallback(
    (direction: -1 | 1) => {
      extendNavBurst();
      if (direction < 0) prevPage();
      else nextPage();
    },
    [prevPage, nextPage, extendNavBurst],
  );

  const flipWithAnim = useCallback(
    (direction: -1 | 1) => {
      setPageTurnAnim(direction > 0 ? "next" : "prev");
      if (direction < 0) prevPage();
      else nextPage();
    },
    [prevPage, nextPage],
  );

  useEffect(() => {
    if (!pageTurnAnim) return;
    const id = window.setTimeout(() => setPageTurnAnim(null), 240);
    return () => window.clearTimeout(id);
  }, [page, pageTurnAnim]);

  useEffect(() => {
    flipRef.current = flipInstant;
  }, [flipInstant]);

  const focusPreview = useCallback(() => {
    wrapNodeRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    registerPreviewActions({ prevPage, nextPage, goToPage });
    return () => registerPreviewActions(null);
  }, [prevPage, nextPage, goToPage]);

  useEffect(() => {
    focusPreview();
  }, [docPath, focusPreview]);

  useEffect(() => {
    if (!scrollToEndRef.current) return;
    scrollToEndRef.current = false;
    const el = wrapNodeRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [page]);

  useEffect(() => {
    const flipFromKey = (direction: -1 | 1) => {
      const now = Date.now();
      if (now < keyPageLockUntilRef.current) return;
      keyPageLockUntilRef.current = now + KEY_PAGE_COOLDOWN_MS;
      flipWithAnim(direction);
    };

    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || isOverlayOpen()) return;

      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "[") {
        e.preventDefault();
        flipFromKey(-1);
        return;
      }
      if (mod && e.key === "]") {
        e.preventDefault();
        flipFromKey(1);
        return;
      }
      if (mod) return;

      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        flipFromKey(-1);
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        flipFromKey(1);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flipWithAnim]);

  const persistZoom = useCallback((z: ZoomMode) => {
    localStorage.setItem(ZOOM_KEY, z === "fit-width" ? "fit-width" : String(z));
  }, []);

  const bumpZoom = useCallback(
    (next: ZoomMode) => {
      if (typeof next === "number") lastNumericRef.current = next;
      setZoom((prev) => (isSameZoom(prev, next) ? prev : next));
      setRefitToken((t) => t + 1);
      persistZoom(next);
    },
    [persistZoom],
  );

  const zoomIn = useCallback(() => {
    const next = stepZoom(zoomRef.current, 1);
    if (typeof next === "number") lastNumericRef.current = next;
    setZoom(next);
    setRefitToken((t) => t + 1);
    persistZoom(next);
  }, [persistZoom]);

  const zoomOut = useCallback(() => {
    const next = stepZoom(zoomRef.current, -1);
    if (typeof next === "number") lastNumericRef.current = next;
    setZoom(next);
    setRefitToken((t) => t + 1);
    persistZoom(next);
  }, [persistZoom]);

  const toggleFitWidth = useCallback(() => {
    const prev = zoomRef.current;
    let next: ZoomMode;
    if (prev === "fit-width") {
      next = lastNumericRef.current;
    } else {
      if (typeof prev === "number") lastNumericRef.current = prev;
      next = "fit-width";
    }
    setZoom(next);
    setRefitToken((t) => t + 1);
    persistZoom(next);
  }, [persistZoom]);

  useEffect(() => {
    if (doc.kind !== "pdf" || !canvasRef.current || viewportWidth < 80) return;

    setTextLayerActive(false);

    let cancelled = false;
    let cleanupTextLayer: (() => void) | undefined;
    const generation = ++renderGenRef.current;
    const pathAtStart = docPath;
    const isStale = () =>
      cancelled || generation !== renderGenRef.current || pathAtStart !== docPath;

    const clearLoadingTimer = () => {
      if (loadingTimerRef.current !== undefined) {
        window.clearTimeout(loadingTimerRef.current);
        loadingTimerRef.current = undefined;
      }
    };

    (async () => {
      const raster = isRasterHeavyPage(currentPageTextLen);
      const baseQuality = effectiveRenderQuality(userQuality, raster);
      const quality = navBurst ? "performance" : baseQuality;
      // NOTE: this must not be gated on the runtime — the desktop (Tauri) build
      // is the production app, and disabling the text layer there kills PDF text
      // selection and the selection→ask affordance entirely.
      const wantTextLayer = !navBurst && !raster && currentPageTextLen > 0;

      const scaleKey = buildScaleKey(
        zoom,
        viewportWidth,
        typeof zoom === "number" ? zoom : 1,
      );

      let cacheHit = false;
      if (canvasRef.current) {
        cacheHit = tryApplyCachedPage(
          docPath,
          page,
          scaleKey,
          quality,
          canvasRef.current,
        );
        if (cacheHit) {
          clearLoadingTimer();
          setShowLoading(false);
          setRenderError(null);
          if (wantTextLayer) {
            setTextLayerActive(true);
          } else {
            setTextLayerActive(false);
          }
        }
      }

      // Resolve the scale inside its own error boundary: a rejection here (bad
      // page, torn document) must surface as a render error, not an unhandled
      // rejection that leaves the canvas silently stuck on the previous page.
      let scale: number;
      if (zoom === "fit-width") {
        try {
          scale = await resolveFitWidthScale(docPath, page, viewportWidth);
        } catch (e) {
          if (!isStale()) {
            clearLoadingTimer();
            setShowLoading(false);
            setRenderError(e instanceof Error ? e.message : t("preview.renderFailed"));
          }
          return;
        }
      } else {
        scale = zoom;
      }

      if (isStale() || !canvasRef.current) return;

      if (!cacheHit) {
        clearLoadingTimer();
        loadingTimerRef.current = window.setTimeout(() => {
          if (!isStale()) setShowLoading(true);
        }, navBurst ? 40 : LOADING_DELAY_MS);
      }

      setRenderError(null);
      if (!cacheHit) setTextLayerActive(false);

      try {
        if (!cacheHit) {
          const result = await renderPageToCanvas(
            docPath,
            page,
            canvasRef.current,
            scale,
            "high",
            quality,
            scaleKey,
            isStale,
          );
          if (result.cancelled && isStale()) return;
        }

        if (isStale()) return;

        clearLoadingTimer();
        setShowLoading(false);

        if (wantTextLayer) {
          setTextLayerActive(true);
        }
      } catch (e) {
        if (!isStale()) {
          setRenderError(e instanceof Error ? e.message : t("preview.renderFailed"));
        }
      } finally {
        if (!isStale()) {
          clearLoadingTimer();
          setShowLoading(false);
        }
      }

      if (!isStale() && docTotalPages > 1) {
        const prefetchQuality = navBurst ? "performance" : baseQuality;
        const prefetch = async (targetPage: number) => {
          const s =
            zoom === "fit-width"
              ? await resolveFitWidthScale(docPath, targetPage, viewportWidth)
              : scale;
          const sk = buildScaleKey(zoom, viewportWidth, s);
          if (!hasPageCache(docPath, targetPage, sk, prefetchQuality)) {
            prefetchPage(docPath, targetPage, s, prefetchQuality, sk);
          }
        };
        // Prefetch is best-effort; a bad neighbor page must not surface as an
        // unhandled rejection.
        if (page > 1) prefetch(page - 1).catch(() => {});
        if (page < docTotalPages) prefetch(page + 1).catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
      clearLoadingTimer();
      cleanupTextLayer?.();
    };
  }, [
    doc.kind,
    docPath,
    docTotalPages,
    currentPageTextLen,
    page,
    zoom,
    refitToken,
    viewportWidth,
    userQuality,
    navBurst,
  ]);

  useLayoutEffect(() => {
    if (!textLayerActive || !textLayerRef.current) return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;
    const generation = renderGenRef.current;
    const pathAtStart = docPath;
    const isStale = () =>
      cancelled || generation !== renderGenRef.current || pathAtStart !== docPath;

    const run = () => {
      void (async () => {
        // The whole body is guarded: the text layer is optional, and a scale
        // or render failure here must degrade silently, never surface as an
        // unhandled rejection (reachable in production since the Tauri
        // text-layer gate was removed).
        try {
          const scale =
            zoom === "fit-width"
              ? await resolveFitWidthScale(docPath, page, viewportWidth)
              : zoom;

          if (isStale() || !textLayerRef.current) return;

          const done = await renderTextLayer(
            docPath,
            page,
            scale,
            textLayerRef.current,
            isStale,
          );
          // Teardown may have run while we awaited — dispose immediately
          // instead of leaking an uncancelled TextLayer.
          if (cancelled) {
            done();
          } else {
            cleanup = done;
          }
        } catch {
          /* text layer optional */
        }
      })();
    };

    if (typeof requestIdleCallback !== "undefined") {
      const id = requestIdleCallback(run, { timeout: 200 });
      return () => {
        cancelled = true;
        cancelIdleCallback(id);
        cleanup?.();
      };
    }

    const id = window.setTimeout(run, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
      cleanup?.();
    };
  }, [textLayerActive, docPath, page, zoom, viewportWidth]);

  return {
    zoom,
    handleZoomChange: bumpZoom,
    zoomIn,
    zoomOut,
    toggleFitWidth,
    canvasRef,
    textLayerRef,
    wrapRef: bindWrap,
    showLoading,
    renderError,
    textLayerActive,
    pageTurnAnim,
    prevPage,
    nextPage,
    focusPreview,
  };
}
