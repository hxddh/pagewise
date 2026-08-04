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
}: UsePdfViewerOptions) {
  const [zoom, setZoom] = useState<ZoomMode>(loadZoom);
  const [quality, setQuality] = useState<PreviewQuality>("crisp");

  const lastNumericRef = useRef(1);
  const pageRef = useRef(page);
  const totalRef = useRef(doc.kind === "pdf" ? doc.totalPages : 1);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  pageRef.current = page;
  totalRef.current = doc.kind === "pdf" ? doc.totalPages : 1;

  useEffect(() => {
    loadPreferences().then((p) => setQuality(p.previewQuality));
  }, [prefsRevision]);

  useEffect(() => {
    setZoom("fit-width");
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

  const bumpZoom = useCallback((next: ZoomMode) => {
    setZoom((prev) => {
      if (isSameZoom(prev, next)) return prev;
      if (typeof next === "number") lastNumericRef.current = next;
      localStorage.setItem(ZOOM_KEY, typeof next === "number" ? String(next) : next);
      return next;
    });
  }, []);

  const zoomIn = useCallback(() => {
    bumpZoom(stepZoom(zoom, 1));
  }, [bumpZoom, zoom]);

  const zoomOut = useCallback(() => {
    bumpZoom(stepZoom(zoom, -1));
  }, [bumpZoom, zoom]);

  const toggleFitWidth = useCallback(() => {
    bumpZoom(zoom === "fit-width" ? lastNumericRef.current : "fit-width");
  }, [bumpZoom, zoom]);

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

  useEffect(() => {
    registerPreviewActions({
      prevPage,
      nextPage,
      goToPage,
    });
    return () => registerPreviewActions(null);
  }, [prevPage, nextPage, goToPage]);

  useEffect(() => {
    if (doc.kind !== "pdf") return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || isOverlayOpen()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "PageDown":
          if (scrollByViewport(1)) e.preventDefault();
          break;
        case "PageUp":
          if (scrollByViewport(-1)) e.preventDefault();
          break;
        case "Home":
          goToPage(1);
          e.preventDefault();
          break;
        case "End":
          goToPage(totalRef.current);
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
  }, [doc.kind, goToPage, nextPage, prevPage, scrollByViewport]);

  return {
    zoom,
    quality,
    handleZoomChange: bumpZoom,
    zoomIn,
    zoomOut,
    toggleFitWidth,
    bindScroller,
    focusPreview,
    prevPage,
    nextPage,
  };
}
