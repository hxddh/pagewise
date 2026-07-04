import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildScaleKey,
  clearPdfCache,
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
import { registerPreviewActions } from "../../lib/preview-actions";
import { isOverlayOpen, isTypingTarget } from "../../lib/shortcut-guards";
import type { LoadedDocument, PreviewQuality } from "../../lib/types";
import { isSameZoom, stepZoom, type ZoomMode } from "../../lib/zoom";
import { normalizeWheelDelta, WHEEL_GESTURE } from "../../lib/wheel-gesture";

const ZOOM_KEY = "pagewise.zoom";
const KEY_PAGE_COOLDOWN_MS = 320;
const NAV_BURST_MS = 400;
const NAV_IDLE_MS = 350;
const LOADING_DELAY_MS = 80;

function loadZoom(): ZoomMode {
  const raw = localStorage.getItem(ZOOM_KEY);
  if (raw === "fit-width") return "fit-width";
  const n = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(n) ? n : "fit-width";
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
  const [showTextLayer, setShowTextLayer] = useState(false);
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

  zoomRef.current = zoom;

  pageRef.current = page;
  totalRef.current = doc.kind === "pdf" ? doc.totalPages : 1;

  useEffect(() => {
    loadPreferences().then((p) => setUserQuality(p.previewQuality));
  }, [prefsRevision]);

  // Per-document reset to fit-width for display. This is a *programmatic* reset
  // and must NOT be persisted, otherwise it would clobber the user's remembered
  // zoom (persistence happens only in the explicit user-action callbacks below).
  useEffect(() => {
    setZoom("fit-width");
    clearPdfCache();
  }, [doc.path]);

  useEffect(() => {
    clearPdfCache();
  }, [userQuality]);

  useEffect(() => {
    const initial = loadZoom();
    if (typeof initial === "number") lastNumericRef.current = initial;
  }, []);

  const bindWrap = useCallback(
    (node: HTMLDivElement | null) => {
      wrapCleanupRef.current?.();
      wrapCleanupRef.current = null;
      wrapNodeRef.current = node;

      if (!node) return;

      const updateWidth = () => setViewportWidth(node.clientWidth);
      updateWidth();
      const ro = new ResizeObserver(updateWidth);
      ro.observe(node);

      if (doc.kind !== "pdf" || doc.totalPages <= 1) {
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

        if (!fitWidth) {
          if (dy > 0 && !atBottom) {
            resetAccum();
            window.clearTimeout(gestureTimer);
            return;
          }
          if (dy < 0 && !atTop) {
            resetAccum();
            window.clearTimeout(gestureTimer);
            return;
          }
        }

        const now = Date.now();
        if (now - lastWheelAt > WHEEL_GESTURE.accumIdleMs) resetAccum();
        lastWheelAt = now;

        const sign = Math.sign(dy);
        if (accumSign !== 0 && sign !== accumSign) resetAccum();
        accumSign = sign;
        accum += dy;

        window.clearTimeout(gestureTimer);
        gestureTimer = window.setTimeout(commitGesture, WHEEL_GESTURE.endMs);

        const threshold = fitWidth ? WHEEL_GESTURE.thresholdFit : WHEEL_GESTURE.thresholdEdge;
        if (fitWidth && Math.abs(accum) >= threshold * 0.4) {
          e.preventDefault();
        }
      };

      node.addEventListener("wheel", onWheel, { passive: false });
      wrapCleanupRef.current = () => {
        ro.disconnect();
        node.removeEventListener("wheel", onWheel);
        window.clearTimeout(gestureTimer);
      };
    },
    [doc.kind, doc.path, doc.totalPages],
  );

  useEffect(() => () => wrapCleanupRef.current?.(), []);

  const noteNavigation = useCallback(() => {
    const now = Date.now();
    if (now - lastNavAtRef.current < NAV_BURST_MS) {
      navBurstCountRef.current += 1;
    } else {
      navBurstCountRef.current = 1;
    }
    lastNavAtRef.current = now;
    if (navBurstCountRef.current >= 2) setNavBurst(true);

    window.clearTimeout(navIdleTimerRef.current);
    navIdleTimerRef.current = window.setTimeout(() => {
      setNavBurst(false);
      navBurstCountRef.current = 0;
    }, NAV_IDLE_MS);
  }, []);

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
    const id = window.setTimeout(() => setPageTurnAnim(null), 280);
    return () => window.clearTimeout(id);
  }, [page, pageTurnAnim]);

  useEffect(() => {
    flipRef.current = flipWithAnim;
  }, [flipWithAnim]);

  const focusPreview = useCallback(() => {
    wrapNodeRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    registerPreviewActions({ prevPage, nextPage, goToPage });
    return () => registerPreviewActions(null);
  }, [prevPage, nextPage, goToPage]);

  useEffect(() => {
    focusPreview();
  }, [doc.path, focusPreview]);

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

      if (direction < 0) prevPage();
      else nextPage();
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
  }, [prevPage, nextPage]);

  // Persist only user-initiated zoom changes. `zoomRef` is kept current every
  // render, so these callbacks read the live zoom without a stale closure and
  // without putting side effects inside a setState updater (StrictMode-safe).
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

    let cancelled = false;
    let cleanupTextLayer: (() => void) | undefined;
    const generation = ++renderGenRef.current;

    const clearLoadingTimer = () => {
      if (loadingTimerRef.current !== undefined) {
        window.clearTimeout(loadingTimerRef.current);
        loadingTimerRef.current = undefined;
      }
    };

    (async () => {
      const pageText = doc.pages[page - 1]?.text.trim().length ?? 0;
      const raster = isRasterHeavyPage(pageText);
      const baseQuality = effectiveRenderQuality(userQuality, raster);
      const quality = navBurst ? "performance" : baseQuality;
      const wantTextLayer = !navBurst && !raster && pageText > 0;

      const scale =
        zoom === "fit-width"
          ? await resolveFitWidthScale(doc.path, page, viewportWidth)
          : zoom;

      if (cancelled || !canvasRef.current || generation !== renderGenRef.current) return;

      const scaleKey = buildScaleKey(zoom, viewportWidth, scale);
      const cacheHit = tryApplyCachedPage(
        doc.path,
        page,
        scaleKey,
        quality,
        canvasRef.current,
      );

      if (!cacheHit) {
        clearLoadingTimer();
        loadingTimerRef.current = window.setTimeout(() => {
          if (!cancelled) setShowLoading(true);
        }, LOADING_DELAY_MS);
      } else {
        clearLoadingTimer();
        setShowLoading(false);
      }

      setRenderError(null);
      setShowTextLayer(wantTextLayer && cacheHit);

      try {
        if (!cacheHit) {
          await renderPageToCanvas(
            doc.path,
            page,
            canvasRef.current,
            scale,
            "high",
            quality,
            scaleKey,
          );
        }

        if (cancelled || generation !== renderGenRef.current) return;

        clearLoadingTimer();
        setShowLoading(false);

        if (wantTextLayer && textLayerRef.current) {
          try {
            const c = await renderTextLayer(
              doc.path,
              page,
              scale,
              textLayerRef.current,
            );
            // If cleanup ran (or a newer render started) while awaiting, the
            // resolved text layer must be cancelled/removed immediately —
            // otherwise it's orphaned and never torn down.
            if (cancelled || generation !== renderGenRef.current) {
              c();
              return;
            }
            cleanupTextLayer = c;
            setShowTextLayer(true);
          } catch {
            if (!cancelled) setShowTextLayer(false);
          }
        } else {
          setShowTextLayer(false);
        }

        if (!cancelled && doc.totalPages > 1) {
          const prefetch = async (targetPage: number) => {
            const s =
              zoom === "fit-width"
                ? await resolveFitWidthScale(doc.path, targetPage, viewportWidth)
                : scale;
            const sk = buildScaleKey(zoom, viewportWidth, s);
            if (!hasPageCache(doc.path, targetPage, sk, quality)) {
              prefetchPage(doc.path, targetPage, s, quality, sk);
            }
          };
          if (page > 1) void prefetch(page - 1);
          if (page < doc.totalPages) void prefetch(page + 1);
        }
      } catch (e) {
        if (!cancelled) {
          setRenderError(e instanceof Error ? e.message : "Failed to render page");
        }
      } finally {
        if (!cancelled) {
          clearLoadingTimer();
          setShowLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      clearLoadingTimer();
      cleanupTextLayer?.();
    };
  }, [doc, page, zoom, refitToken, viewportWidth, userQuality, navBurst]);

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
    showTextLayer,
    pageTurnAnim,
    prevPage,
    nextPage,
    focusPreview,
  };
}
