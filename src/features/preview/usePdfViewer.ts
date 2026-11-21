import { useCallback, useEffect, useRef, useState } from "react";
import { clearPageBitmapCache } from "../../lib/pdf";
import { loadPreferences } from "../../lib/preferences";
import { registerPreviewActions } from "../../lib/preview-actions";
import { isOverlayOpen, isTypingTarget } from "../../lib/shortcut-guards";
import type { LoadedDocument, PreviewQuality } from "../../lib/types";
import { isSameZoom, stepZoom, type ZoomMode } from "../../lib/zoom";

const ZOOM_KEY = "pagewise.zoom";
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

function loadZoom(): ZoomMode {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(ZOOM_KEY);
  } catch {
    // Storage refused (private mode): the default.
  }
  if (raw === "fit-width" || raw === "fit-page" || raw === "comfortable") return raw;
  const n = raw ? parseFloat(raw) : NaN;
  if (!Number.isFinite(n)) return "fit-width";
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, n));
}

const MAX_HISTORY = 32;

export interface ReaderPlace {
  page: number;
  topFraction: number;
}

interface UsePdfViewerOptions {
  doc: LoadedDocument;
  page: number;
  onPageChange: (page: number) => void;
  prefsRevision?: number;
  onToggleThumbs?: () => void;
  onRestorePlace?: (place: ReaderPlace) => void;
}

/**
 * Zoom, render quality and the keyboard, for a document that scrolls.
 *
 * Everything about drawing a page and deciding which page that is now lives in
 * `PageScroller` — this hook used to own a canvas, a page-turn animation and a
 * wheel gesture that flipped pages, none of which survive a scrolling document.
 * Paging by keyboard remains, because Page Up/Down and Home/End are how a
 * reader moves a screenful without touching the mouse.
 */
export function usePdfViewer({
  doc,
  page,
  onPageChange,
  prefsRevision = 0,
  onToggleThumbs,
  onRestorePlace,
}: UsePdfViewerOptions) {
  const [zoom, setZoom] = useState<ZoomMode>(loadZoom);
  const [quality, setQuality] = useState<PreviewQuality>("crisp");
  const [historyState, setHistoryState] = useState({ back: 0, forward: 0, backPage: 0 });

  const lastNumericRef = useRef(1);
  const resolvedScaleRef = useRef(1);
  const backStackRef = useRef<ReaderPlace[]>([]);
  const forwardStackRef = useRef<ReaderPlace[]>([]);
  const onToggleThumbsRef = useRef(onToggleThumbs);
  onToggleThumbsRef.current = onToggleThumbs;
  const onRestorePlaceRef = useRef(onRestorePlace);
  onRestorePlaceRef.current = onRestorePlace;
  const pageRef = useRef(page);
  const totalRef = useRef(doc.kind === "pdf" ? doc.totalPages : 1);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  pageRef.current = page;
  totalRef.current = doc.kind === "pdf" ? doc.totalPages : 1;

  useEffect(() => {
    loadPreferences().then((p) => setQuality(p.previewQuality));
  }, [prefsRevision]);

  // A newly opened document starts at the reader's saved zoom. Until 16.0
  // this reset to fit-width — on mount too, so the saved zoom never applied
  // at all (B19).
  const zoomPathRef = useRef(doc.path);
  useEffect(() => {
    if (zoomPathRef.current === doc.path) return;
    zoomPathRef.current = doc.path;
    backStackRef.current = [];
    forwardStackRef.current = [];
    setHistoryState({ back: 0, forward: 0, backPage: 0 });
    setZoom(loadZoom());
  }, [doc.path]);

  useEffect(() => {
    // Quality only affects rasterized bitmaps — drop those and re-render, but
    // keep the loaded pdf.js document and cached bytes.
    clearPageBitmapCache();
  }, [quality]);

  useEffect(() => {
    const initial = loadZoom();
    if (typeof initial === "number") lastNumericRef.current = initial;
  }, []);

  const bindScroller = useCallback((node: HTMLDivElement | null) => {
    scrollerRef.current = node;
  }, []);

  const focusPreview = useCallback(() => {
    scrollerRef.current?.focus({ preventScroll: true });
  }, []);

  const onScaleResolved = useCallback((scale: number) => {
    if (Number.isFinite(scale) && scale > 0) resolvedScaleRef.current = scale;
  }, []);

  const persistZoom = useCallback((next: ZoomMode) => {
    try {
      localStorage.setItem(ZOOM_KEY, typeof next === "number" ? String(next) : next);
    } catch {
      // Ignore storage errors in restricted contexts.
    }
  }, []);

  const bumpZoom = useCallback(
    (next: ZoomMode) => {
      setZoom((prev) => {
        if (isSameZoom(prev, next)) return prev;
        if (typeof next === "number") lastNumericRef.current = next;
        persistZoom(next);
        return next;
      });
    },
    [persistZoom],
  );

  const handlePinchZoom = useCallback(
    (next: number, settled = false) => {
      lastNumericRef.current = next;
      setZoom((prev) => (isSameZoom(prev, next) ? prev : next));
      if (settled) persistZoom(next);
    },
    [persistZoom],
  );

  const zoomIn = useCallback(() => {
    bumpZoom(stepZoom(zoom, 1, resolvedScaleRef.current));
  }, [bumpZoom, zoom]);

  const zoomOut = useCallback(() => {
    bumpZoom(stepZoom(zoom, -1, resolvedScaleRef.current));
  }, [bumpZoom, zoom]);

  const toggleFitWidth = useCallback(() => {
    bumpZoom(zoom === "fit-width" ? lastNumericRef.current : "fit-width");
  }, [bumpZoom, zoom]);

  const toggleFitPage = useCallback(() => {
    bumpZoom(zoom === "fit-page" ? "fit-width" : "fit-page");
  }, [bumpZoom, zoom]);

  const syncHistoryState = useCallback(() => {
    const back = backStackRef.current;
    setHistoryState({
      back: back.length,
      forward: forwardStackRef.current.length,
      backPage: back.length > 0 ? back[back.length - 1]!.page : 0,
    });
  }, []);

  const readCurrentPlace = useCallback((): ReaderPlace => {
    const curPage = pageRef.current;
    const scroller = scrollerRef.current;
    if (!scroller) return { page: curPage, topFraction: 0 };
    const slot = scroller.querySelector<HTMLElement>(`.pdf-page-slot[data-page="${curPage}"]`);
    if (!slot || slot.offsetHeight <= 0) return { page: curPage, topFraction: 0 };
    const raw = (scroller.scrollTop - slot.offsetTop) / slot.offsetHeight;
    const topFraction = Math.min(0.98, Math.max(0, Number.isFinite(raw) ? raw : 0));
    return { page: curPage, topFraction };
  }, []);

  const recordJumpFromCurrent = useCallback(
    (targetPage: number) => {
      const clamped = Math.min(totalRef.current, Math.max(1, targetPage));
      if (Math.abs(clamped - pageRef.current) < 2) return;
      const cur = readCurrentPlace();
      const prevTop = backStackRef.current[backStackRef.current.length - 1];
      if (!prevTop || prevTop.page !== cur.page) {
        backStackRef.current.push(cur);
        if (backStackRef.current.length > MAX_HISTORY) backStackRef.current.shift();
      } else {
        prevTop.topFraction = cur.topFraction;
      }
      forwardStackRef.current = [];
      syncHistoryState();
    },
    [readCurrentPlace, syncHistoryState],
  );

  const goBack = useCallback(() => {
    const entry = backStackRef.current.pop();
    if (!entry) return false;
    forwardStackRef.current.push(readCurrentPlace());
    if (forwardStackRef.current.length > MAX_HISTORY) forwardStackRef.current.shift();
    syncHistoryState();
    onPageChange(entry.page);
    onRestorePlaceRef.current?.(entry);
    return true;
  }, [onPageChange, readCurrentPlace, syncHistoryState]);

  const goForward = useCallback(() => {
    const entry = forwardStackRef.current.pop();
    if (!entry) return false;
    backStackRef.current.push(readCurrentPlace());
    if (backStackRef.current.length > MAX_HISTORY) backStackRef.current.shift();
    syncHistoryState();
    onPageChange(entry.page);
    onRestorePlaceRef.current?.(entry);
    return true;
  }, [onPageChange, readCurrentPlace, syncHistoryState]);

  const goToPage = useCallback(
    (next: number) => {
      const clamped = Math.min(totalRef.current, Math.max(1, next));
      if (clamped !== pageRef.current) onPageChange(clamped);
    },
    [onPageChange],
  );

  const prevPage = useCallback(() => goToPage(pageRef.current - 1), [goToPage]);
  const nextPage = useCallback(() => goToPage(pageRef.current + 1), [goToPage]);

  // Page Up/Down move by a screenful rather than by a page: with the document
  // on one surface, a "page" of scrolling is what the reader can see, which is
  // not the same thing as a sheet of paper.
  const scrollByViewport = useCallback((direction: -1 | 1) => {
    const node = scrollerRef.current;
    if (!node) return false;
    node.scrollBy({ top: direction * Math.max(120, node.clientHeight - 64), behavior: "auto" });
    return true;
  }, []);

  // Home and End go to the ends of the document, not to the top of the first
  // or last page. While the preview flipped, "go to page 1" and "go to the
  // start" were the same act; scrolling separated them, and `goToPage` does
  // nothing at all when the page it is asked for is the page already current —
  // so Home did nothing from halfway down page 1, and End did nothing from the
  // top of the last page. The scroll container is what has ends now.
  const scrollToEnd = useCallback(
    (edge: "start" | "end") => {
      const node = scrollerRef.current;
      if (!node) {
        goToPage(edge === "start" ? 1 : totalRef.current);
        return;
      }
      node.scrollTo({ top: edge === "start" ? 0 : node.scrollHeight, behavior: "auto" });
    },
    [goToPage],
  );

  const jumpToPage = useCallback(
    (next: number) => {
      recordJumpFromCurrent(next);
      goToPage(next);
    },
    [recordJumpFromCurrent, goToPage],
  );

  useEffect(() => {
    registerPreviewActions({
      prevPage,
      nextPage,
      goToPage,
      jumpToPage,
    });
    return () => registerPreviewActions(null);
  }, [prevPage, nextPage, goToPage, jumpToPage]);

  useEffect(() => {
    if (doc.kind !== "pdf") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (isTypingTarget(e.target) || isOverlayOpen()) return;
      const inChatColumn =
        (e.target instanceof Element && !!e.target.closest(".chat-column")) ||
        (document.activeElement instanceof Element && !!document.activeElement.closest(".chat-column"));
      if (inChatColumn && !(e.metaKey || e.ctrlKey)) return;
      /*
       * Zoom on the chord every reader already knows (17.0), before the
       * modifier guard below — that guard exists to keep page keys unmodified.
       * `=` is what `+` produces without shift, and both spellings are accepted
       * because the key a reader presses depends on their keyboard.
       */
      if (e.metaKey || e.ctrlKey) {
        if (e.altKey) return;
        if (e.key === "=" || e.key === "+") {
          zoomIn();
          e.preventDefault();
          return;
        }
        if (e.key === "-" || e.key === "_") {
          zoomOut();
          e.preventDefault();
          return;
        }
        if (e.key === "0") {
          toggleFitWidth();
          e.preventDefault();
          return;
        }
        if (e.key === "9") {
          toggleFitPage();
          e.preventDefault();
          return;
        }
        if (!e.shiftKey && e.key.toLowerCase() === "b" && totalRef.current > 1 && onToggleThumbsRef.current) {
          onToggleThumbsRef.current();
          e.preventDefault();
          return;
        }
        return;
      }
      if (e.altKey) {
        if (!e.shiftKey && e.key === "ArrowLeft") {
          if (goBack()) e.preventDefault();
        } else if (!e.shiftKey && e.key === "ArrowRight") {
          if (goForward()) e.preventDefault();
        }
        return;
      }
      switch (e.key) {
        case "PageDown":
          if (scrollByViewport(1)) e.preventDefault();
          break;
        case "PageUp":
          if (scrollByViewport(-1)) e.preventDefault();
          break;
        /*
         * j/k, the reading keys: a viewport at a time, like PageDown/PageUp.
         * Bound to the scroll rather than to a page turn so they never skip
         * past the paragraph the reader is in the middle of.
         */
        case "j":
          if (scrollByViewport(1)) e.preventDefault();
          break;
        case "k":
          if (scrollByViewport(-1)) e.preventDefault();
          break;
        case "Home":
          scrollToEnd("start");
          e.preventDefault();
          break;
        case "End":
          scrollToEnd("end");
          e.preventDefault();
          break;
        case "ArrowRight":
          nextPage();
          e.preventDefault();
          break;
        case "ArrowLeft":
          prevPage();
          e.preventDefault();
          break;
        default:
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    doc.kind,
    nextPage,
    prevPage,
    scrollByViewport,
    scrollToEnd,
    zoomIn,
    zoomOut,
    toggleFitWidth,
    toggleFitPage,
    goBack,
    goForward,
  ]);

  return {
    zoom,
    quality,
    handleZoomChange: bumpZoom,
    handlePinchZoom,
    onScaleResolved,
    zoomIn,
    zoomOut,
    toggleFitWidth,
    toggleFitPage,
    bindScroller,
    focusPreview,
    prevPage,
    nextPage,
    recordJumpFromCurrent,
    canGoBack: historyState.back > 0,
    canGoForward: historyState.forward > 0,
    backPage: historyState.backPage,
    goBack,
    goForward,
  };
}
