import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { buildScaleKey, measurePages, prerenderPageInIdle } from "../../lib/pdf";
import type { LoadedDocument, PreviewQuality } from "../../lib/types";
import type { ZoomMode } from "../../lib/zoom";
import { PageSlot } from "./PageSlot";
import type { PageMarginBox } from "./PageGutter";
import {
  fitComfortableScale,
  fitPageScale,
  fitWidthScale,
  layoutPages,
  offsetForPage,
  offsetForPageRect,
  pageAtScroll,
  PAGE_GAP,
  scrollShiftForRelayout,
  scrollShiftForScale,
  visibleRange,
  type PageSize,
} from "./page-layout";

const PAD_LEFT = 24;
/**
 * The margin the page keeps on its right when the column is showing dots
 * (panel open) — the strip the dots sit in.
 */
const DOT_PADDING = 24;
/**
 * The margin column's width when the panel is closed (20.0).
 *
 * The column is where a short answer, its sentence states, a finding and the
 * reader's own marks sit beside the page — so the panel does not have to open
 * for the common case. It is reserved only while the panel is closed: with the
 * panel open the reader has already bought those answers, and a column would
 * spend a quarter of the page's width on something already on screen.
 */
const MARGIN_COLUMN = 240;
/**
 * The collapsed panel's handle, which sits at the window's right edge and is
 * part of the column's band. `.agent-dock`'s width in `02-shell-layout.css`.
 */
const AGENT_DOCK_WIDTH = 52;
/**
 * The scroller's right padding while the column is showing: the band less the
 * dock that occupies its right edge. The padding is the scroller's own, set
 * inline and transitioned (`preview.css`), so the column arrives as the panel
 * leaves — one movement, not a page that first narrows for a column and then
 * grows as the panel finishes leaving.
 */
const COLUMN_PADDING = MARGIN_COLUMN - AGENT_DOCK_WIDTH;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
/** Below this, a scroll is treated as reading rather than seeking. */
const HURRY_PX_PER_TICK = 240;
const HURRY_IDLE_MS = 160;
/** Pages measured either side of the mounted window, so the layout runs ahead. */
const MEASURE_MARGIN = 8;

export interface SubPageScrollTarget {
  page: number;
  topFraction: number;
  heightFraction: number;
  nonce: number;
  /** Restore exact viewport top offset (`topFraction`) instead of comfort-band framing. */
  exact?: boolean;
}

interface PageScrollerProps {
  doc: LoadedDocument;
  /** 1-based page the rest of the app believes is current. */
  page: number;
  onPageChange: (page: number) => void;
  zoom: ZoomMode;
  quality: PreviewQuality;
  /** Report the effective numeric scale so keyboard zoom steps stay monotonic. */
  onScaleResolved?: (scale: number) => void;
  /** Trackpad pinch-to-zoom handler (`wheel` with `ctrlKey`/`metaKey`). */
  onPinchZoom?: (nextScale: number, settled?: boolean) => void;
  /** Sub-page target box to scroll smoothly into the comfortable reading band. */
  scrollTarget?: SubPageScrollTarget | null;
  /**
   * True while the panel is closed and the margin column is showing.
   *
   * The column reserves width then, and only then (20.0): the page narrows and
   * fit-width zooms out so the notes fit beside it, while with the panel open
   * the margin collapses back to its dots.
   */
  marginColumn?: boolean;
  /** Rendered inside each page, positioned against that page. */
  renderOverlays?: (page: number, state: { textLayerActive: boolean }) => React.ReactNode;
  /**
   * Rendered in the page's outer margin, beside the page box.
   *
   * A sibling of the page rather than a child: a page clips its own overlays
   * (`.pdf-page-slot` is `overflow: hidden`, so a mark can never draw over the
   * neighbouring page), and the margin is by definition outside that box. The
   * box is handed over already computed, so the gutter draws where the layout
   * says the page is instead of working out a second position.
   */
  renderGutter?: (page: number, box: PageMarginBox) => React.ReactNode;
  containerRef?: (node: HTMLDivElement | null) => void;
}

/**
 * The document as one scrolling surface.
 *
 * PageWise used to draw one page and flip. Every mainstream reader scrolls, and
 * the flip model broke the things reading is made of: a paragraph across a page
 * break, two facing numbers, a scan for the figure you half remember. Pages are
 * virtualized — only those on screen and their neighbours are mounted — because
 * a thousand-page document cannot hold a thousand canvases.
 */
function seedInitialSizes(
  doc: LoadedDocument,
  pageCount: number,
): { sizes: Array<PageSize | undefined>; seeded: number[] } {
  const sizes: Array<PageSize | undefined> = [];
  const seeded: number[] = [];
  for (const entry of doc.initialPageSizes ?? []) {
    if (
      entry.page >= 1 &&
      entry.page <= pageCount &&
      entry.size.width > 0 &&
      entry.size.height > 0
    ) {
      sizes[entry.page - 1] = entry.size;
      seeded.push(entry.page);
    }
  }
  return { sizes, seeded };
}

export function PageScroller({
  doc,
  page,
  onPageChange,
  zoom,
  quality,
  onScaleResolved,
  onPinchZoom,
  scrollTarget = null,
  marginColumn = false,
  renderOverlays,
  renderGutter,
  containerRef,
}: PageScrollerProps) {
  const pageCount = doc.kind === "pdf" ? Math.max(1, doc.totalPages) : 1;
  const [sizes, setSizes] = useState<Array<PageSize | undefined>>(
    () => seedInitialSizes(doc, pageCount).sizes,
  );
  const [containerWidth, setContainerWidth] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  // The scroller's right padding, read back from the computed style: it is
  // what the margin column reserves, and it is transitioned, so the value
  // mid-animation is the one the fit has to use.
  const [padRight, setPadRight] = useState(DOT_PADDING);
  const [hurried, setHurried] = useState(false);
  const [pinching, setPinching] = useState(false);
  const [columnTransitioning, setColumnTransitioning] = useState(false);
  const [selectionPage, setSelectionPage] = useState<number | null>(null);

  const nodeRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  // Set while this component is scrolling itself to a page, so the scroll it
  // causes is not read back as the reader having navigated.
  const selfScrollRef = useRef(false);
  const lastScrollRef = useRef(0);
  const scrollDirRef = useRef<1 | -1>(1);
  const hurriedRef = useRef(false);
  hurriedRef.current = hurried;
  const prevMarginColumnRef = useRef(marginColumn);
  const columnTimerRef = useRef<number | undefined>(undefined);
  const hurryTimerRef = useRef<number | undefined>(undefined);
  const pinchTimerRef = useRef<number | undefined>(undefined);
  const rafRef = useRef<number | undefined>(undefined);
  // Pages asked for, and pages whose answer came back. A window abandoned
  // mid-flight has to leave its unanswered pages askable again, or scrolling
  // quickly past them would strand them at the fallback size forever.
  const initialSeed = seedInitialSizes(doc, pageCount).seeded;
  const requestedRef = useRef<Set<number>>(new Set(initialSeed));
  const measuredRef = useRef<Set<number>>(new Set(initialSeed));

  useEffect(() => {
    const { sizes: seededSizes, seeded } = seedInitialSizes(doc, pageCount);
    requestedRef.current = new Set(seeded);
    measuredRef.current = new Set(seeded);
    setSizes(seededSizes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.path, pageCount]);

  useEffect(() => {
    if (prevMarginColumnRef.current === marginColumn) return;
    prevMarginColumnRef.current = marginColumn;
    setColumnTransitioning(true);
    window.clearTimeout(columnTimerRef.current);
    columnTimerRef.current = window.setTimeout(() => setColumnTransitioning(false), 200);
    return () => window.clearTimeout(columnTimerRef.current);
  }, [marginColumn]);

  // Fit-width fits the widest page measured so far, so arriving at a landscape
  // page mid-document narrows the column once. Measuring every page up front to
  // avoid that costs an unbounded chain of `getPage` on every open, for pages
  // most readers never reach — the one reflow is the cheaper of the two.
  //
  // The right padding is what the margin column reserves; the scroller carries
  // it as its own padding, so the page is laid out in what is left between the
  // two reserves and keeps its left edge whether the column is there or not.
  const scale = useMemo(() => {
    if (typeof zoom === "number") return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    if (containerWidth <= 0) return 1;
    if (zoom === "comfortable") {
      return fitComfortableScale(sizes, containerWidth, { left: PAD_LEFT, right: padRight });
    }
    if (zoom === "fit-page") {
      return fitPageScale(
        sizes,
        containerWidth,
        viewportHeight,
        { left: PAD_LEFT, right: padRight },
        page,
      );
    }
    return fitWidthScale(sizes, containerWidth, { left: PAD_LEFT, right: padRight });
  }, [zoom, sizes, containerWidth, viewportHeight, padRight, page]);

  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const latestPinchScaleRef = useRef(scale);
  if (!pinching) latestPinchScaleRef.current = scale;
  const pinchingRef = useRef(pinching);
  pinchingRef.current = pinching;
  const pinchAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const zoomSubpixelYRef = useRef(0);
  const onPinchZoomRef = useRef(onPinchZoom);
  onPinchZoomRef.current = onPinchZoom;

  useEffect(() => {
    onScaleResolved?.(scale);
  }, [scale, onScaleResolved]);

  const layout = useMemo(
    () => layoutPages(sizes, pageCount, scale, PAGE_GAP),
    [sizes, pageCount, scale],
  );

  // Zoomed past the container width, the column has to be as wide as its
  // widest page or the half of that page hanging off centre is unreachable.
  const widest = layout.widths.length > 0 ? Math.max(...layout.widths) : 0;

  const { first: visFirst, last: visLast } = visibleRange(layout, scrollTop, viewportHeight, 0);
  const { first, last } = visibleRange(layout, scrollTop, viewportHeight, 1);

  // Speculative directional pre-rasterization after steady user scrolling so
  // reading scroll hits warm ImageBitmaps without competing with open/resize/chat (29.0).
  useEffect(() => {
    if (
      doc.kind !== "pdf" ||
      scrollTop <= 0 ||
      hurried ||
      pinching ||
      columnTransitioning ||
      containerWidth <= 0 ||
      pageCount <= 1
    ) {
      return;
    }
    const nextTarget = scrollDirRef.current >= 0 ? last + 1 : first - 1;
    if (nextTarget < 1 || nextTarget > pageCount) return;
    let cancelled = false;
    let idleId = 0;
    const scaleKey = buildScaleKey(zoom, containerWidth, scale, PAD_LEFT + padRight);
    const run = () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.querySelector(".markdown-stream-caret")) return;
      prerenderPageInIdle(doc.path, nextTarget, scale, quality, scaleKey, () => cancelled);
    };
    const settleTimer = setTimeout(() => {
      if (cancelled) return;
      if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
        idleId = window.requestIdleCallback(run);
      } else {
        run();
      }
    }, 650);
    return () => {
      cancelled = true;
      clearTimeout(settleTimer);
      if (idleId && typeof window !== "undefined" && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId);
      }
    };
    // Only re-arm when the visible page window moves during reading scroll,
    // never on panel resize (`containerWidth` / `padRight`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.kind, doc.path, pageCount, first, last, hurried, pinching, columnTransitioning]);

  // Measure the window the reader is in, and a margin either side. Measuring
  // the whole document on open is a background chain with no ceiling; the
  // layout already stands unmeasured pages in at the first known size, so
  // measuring as the reader arrives is the same picture at a bounded cost.
  useEffect(() => {
    let cancelled = false;
    const from = Math.max(1, first - MEASURE_MARGIN);
    const to = Math.min(pageCount, last + MEASURE_MARGIN);
    const wanted: number[] = [];
    // Page 1 leads: every page not yet measured is laid out at its size.
    if (!requestedRef.current.has(1)) wanted.push(1);
    for (let p = from; p <= to; p++) {
      if (!requestedRef.current.has(p)) wanted.push(p);
    }
    if (wanted.length === 0) return;
    for (const p of wanted) requestedRef.current.add(p);

    void measurePages(
      doc.path,
      wanted,
      (measured) => {
        if (cancelled) return;
        for (const m of measured) measuredRef.current.add(m.page);
        setSizes((prev) => {
          const next = prev.slice();
          for (const m of measured) next[m.page - 1] = m.size;
          return next;
        });
      },
      () => cancelled,
    );

    return () => {
      cancelled = true;
      for (const p of wanted) {
        if (!measuredRef.current.has(p)) requestedRef.current.delete(p);
      }
    };
  }, [doc.path, pageCount, first, last]);

  // The scroller's own geometry, read back from the node: the padding is the
  // column's reserve and it is transitioned, so the value mid-animation is the
  // one the fit has to use — the ResizeObserver fires on content-box changes,
  // which is exactly what an animating padding produces.
  const readLayout = useCallback(() => {
    const node = nodeRef.current;
    if (!node) return;
    setContainerWidth(node.clientWidth);
    setViewportHeight(node.clientHeight);
    setPadRight(parseFloat(getComputedStyle(node).paddingRight) || 0);
  }, []);

  // Re-read when the reserve is told to change as well: in a browser the
  // transition is only starting here (the observer follows it), but without a
  // layout engine the inline padding is the whole truth.
  useEffect(() => {
    readLayout();
  }, [readLayout, marginColumn]);

  const bind = useCallback(
    (node: HTMLDivElement | null) => {
      nodeRef.current = node;
      containerRef?.(node);
      if (!node) return;
      readLayout();
      const ro = new ResizeObserver(readLayout);
      ro.observe(node);
      const onWheel = (e: WheelEvent) => {
        if (!(e.ctrlKey || e.metaKey) || !onPinchZoomRef.current) return;
        e.preventDefault();
        const rect = node.getBoundingClientRect();
        pinchAnchorRef.current = {
          x: Math.max(0, Math.min(node.clientWidth, e.clientX - rect.left)),
          y: Math.max(0, Math.min(node.clientHeight, e.clientY - rect.top)),
        };
        const factor = Math.exp(-e.deltaY * 0.0045);
        const baseScale = pinchingRef.current ? latestPinchScaleRef.current : scaleRef.current;
        const next = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, Math.round(baseScale * factor * 1000) / 1000),
        );
        latestPinchScaleRef.current = next;
        setPinching(true);
        onPinchZoomRef.current(next, false);
        window.clearTimeout(pinchTimerRef.current);
        pinchTimerRef.current = window.setTimeout(() => {
          setPinching(false);
          zoomSubpixelYRef.current = 0;
          onPinchZoomRef.current?.(latestPinchScaleRef.current, true);
        }, 120);
      };
      node.addEventListener("wheel", onWheel, { passive: false });
      // React 19 calls this cleanup instead of re-invoking the ref with null,
      // so anything holding the node has to be told here or it keeps pointing
      // at a node that has left the document.
      return () => {
        node.removeEventListener("wheel", onWheel);
        ro.disconnect();
        nodeRef.current = null;
        containerRef?.(null);
      };
    },
    [containerRef, readLayout],
  );

  useEffect(() => {
    const onSelection = () => {
      const node = nodeRef.current;
      const sel = window.getSelection();
      if (!node || !sel || sel.isCollapsed || !sel.anchorNode || !node.contains(sel.anchorNode)) {
        setSelectionPage((prev) => (prev === null ? prev : null));
        return;
      }
      const el =
        sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode.parentElement;
      const slot = el?.closest<HTMLElement>(".pdf-page-slot[data-page]");
      const p = slot ? Number(slot.dataset.page) : NaN;
      const next = Number.isInteger(p) && p >= 1 ? p : null;
      setSelectionPage((prev) => (prev === next ? prev : next));
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, []);

  // Hold the reader's place when the column reflows under them.
  //
  // Pages are measured as the reader reaches them, so scrolling back up through
  // a stretch that was jumped over measures each page for the first time and
  // moves everything below it — including the paragraph being read. This runs
  // before the page-sync effect below so that effect sees the corrected scroll
  // and has nothing left to do.
  //
  // A scale change is anchored by ratio rather than by page top (20.0): the
  // margin column opening, a landscape page being measured, a zoom. The reader
  // stays on the same page, the same fraction of the way down it, instead of
  // being thrown back to the page's top.
  const relayoutRef = useRef({ layout, scale });
  // Set when a scale change re-anchored the reader: the page under them was
  // re-derived there, and the page-sync effect must not read the app's page
  // from before the change and jump back to its top.
  const scaleAnchoredRef = useRef(false);
  // The latest `onPageChange`, so the anchor effect can report a page that
  // changed under the reader without re-running on every parent render.
  const onPageChangeRef = useRef(onPageChange);
  onPageChangeRef.current = onPageChange;
  useLayoutEffect(() => {
    const node = nodeRef.current;
    const prev = relayoutRef.current;
    relayoutRef.current = { layout, scale };
    if (!node) return;
    if (prev.scale !== scale) {
      const pointer = pinchAnchorRef.current;
      pinchAnchorRef.current = null;
      const anchorY = pointer ? pointer.y : 0;
      const rawShift = scrollShiftForScale(prev.layout, layout, node.scrollTop + anchorY, 0);
      const totalShift = rawShift + zoomSubpixelYRef.current;
      const wholeShift = Math.trunc(totalShift);
      zoomSubpixelYRef.current = totalShift - wholeShift;

      const prevWidest = prev.layout.widths.length > 0 ? Math.max(...prev.layout.widths) : 0;
      const nextWidest = layout.widths.length > 0 ? Math.max(...layout.widths) : 0;
      const prevContentW = Math.max(node.clientWidth, prevWidest + PAD_LEFT + padRight);
      const nextContentW = Math.max(node.clientWidth, nextWidest + PAD_LEFT + padRight);
      let nextScrollLeft = node.scrollLeft;
      if (nextContentW > node.clientWidth || node.scrollLeft > 0) {
        const anchorX = pointer ? pointer.x : node.clientWidth / 2;
        const ratioX = (node.scrollLeft + anchorX) / Math.max(1, prevContentW);
        nextScrollLeft = Math.max(
          0,
          Math.min(nextContentW - node.clientWidth, Math.round(ratioX * nextContentW - anchorX)),
        );
      }

      if (wholeShift !== 0 || nextScrollLeft !== node.scrollLeft) {
        selfScrollRef.current = true;
        if (wholeShift !== 0) node.scrollTop = Math.max(0, node.scrollTop + wholeShift);
        if (nextScrollLeft !== node.scrollLeft) node.scrollLeft = nextScrollLeft;
        setScrollTop(node.scrollTop);
        requestAnimationFrame(() => {
          selfScrollRef.current = false;
        });
      }
      const next = pageAtScroll(layout, node.scrollTop, node.clientHeight);
      if (next !== pageRef.current) {
        onPageChangeRef.current(next);
        // The page under the reader changed with the scale; the app is about
        // to hear about it. This commit's `page` predates the change, so the
        // page-sync effect must not read it and jump back to that page's top.
        scaleAnchoredRef.current = true;
      }
      return;
    }
    const shift = scrollShiftForRelayout(prev.layout, layout, node.scrollTop, node.clientHeight);
    if (shift === 0) return;
    selfScrollRef.current = true;
    node.scrollTop += shift;
    setScrollTop(node.scrollTop);
    requestAnimationFrame(() => {
      selfScrollRef.current = false;
    });
  }, [layout, scale]);

  const handledTargetNonceRef = useRef<number>(0);

  // Bring the view to a page the rest of the app navigated to (outline click,
  // a citation, the page box). Scrolling here must not echo back as a page
  // change, or the two would fight.
  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (scaleAnchoredRef.current) {
      // The scale change above has just re-derived the page under the reader;
      // this commit's `page` predates it.
      scaleAnchoredRef.current = false;
      return;
    }
    if (!node || layout.tops.length === 0) return;
    if (
      scrollTarget &&
      scrollTarget.page === page &&
      handledTargetNonceRef.current !== scrollTarget.nonce
    ) {
      // Sub-page target effect below owns this navigation's exact scroll position.
      return;
    }
    const current = pageAtScroll(layout, node.scrollTop, node.clientHeight);
    if (current === page) return;
    selfScrollRef.current = true;
    node.scrollTop = offsetForPage(layout, page);
    setScrollTop(node.scrollTop);
    // Cleared on the next frame: the scroll event this caused lands first.
    requestAnimationFrame(() => {
      selfScrollRef.current = false;
    });
  }, [page, layout, scrollTarget]);

  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node || !scrollTarget || layout.tops.length === 0) return;
    if (handledTargetNonceRef.current === scrollTarget.nonce) return;
    if (scrollTarget.page < 1 || scrollTarget.page > layout.tops.length) return;
    handledTargetNonceRef.current = scrollTarget.nonce;
    let desired: number | null;
    if (scrollTarget.exact) {
      const idx = scrollTarget.page - 1;
      const maxScroll = Math.max(0, layout.total - node.clientHeight);
      const clampedTop = Math.min(1, Math.max(0, scrollTarget.topFraction));
      desired = Math.min(
        maxScroll,
        Math.max(0, Math.round((layout.tops[idx] ?? 0) + clampedTop * (layout.heights[idx] ?? 0))),
      );
    } else {
      desired = offsetForPageRect(
        layout,
        scrollTarget.page,
        scrollTarget.topFraction,
        scrollTarget.heightFraction,
        node.clientHeight,
        node.scrollTop,
      );
    }
    if (desired === null) return;
    selfScrollRef.current = true;
    node.scrollTop = desired;
    setScrollTop(desired);
    requestAnimationFrame(() => {
      selfScrollRef.current = false;
    });
  }, [scrollTarget, layout]);

  const onScroll = useCallback(() => {
    const node = nodeRef.current;
    if (!node) return;
    const top = node.scrollTop;
    // A scroll fires far more often than a frame is drawn, and this state
    // decides which pages are mounted — one commit per frame is the most that
    // can show. Everything below is cheap enough to run per event.
    if (rafRef.current === undefined) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = undefined;
        const current = nodeRef.current;
        if (current) setScrollTop(current.scrollTop);
      });
    }

    const delta = top - lastScrollRef.current;
    if (delta !== 0) scrollDirRef.current = delta > 0 ? 1 : -1;
    const jump = Math.abs(delta);
    lastScrollRef.current = top;
    if (jump > HURRY_PX_PER_TICK) {
      setHurried(true);
      window.clearTimeout(hurryTimerRef.current);
      hurryTimerRef.current = window.setTimeout(() => setHurried(false), HURRY_IDLE_MS);
    } else if (hurriedRef.current && jump > 24) {
      window.clearTimeout(hurryTimerRef.current);
      hurryTimerRef.current = window.setTimeout(() => setHurried(false), HURRY_IDLE_MS);
    }

    if (selfScrollRef.current) return;
    const next = pageAtScroll(layout, top, node.clientHeight);
    if (next !== pageRef.current) onPageChange(next);
  }, [layout, onPageChange]);

  useEffect(
    () => () => {
      window.clearTimeout(hurryTimerRef.current);
      window.clearTimeout(pinchTimerRef.current);
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const mountedPages: number[] = [];
  if (selectionPage !== null && selectionPage >= 1 && selectionPage < first && selectionPage <= pageCount) {
    mountedPages.push(selectionPage);
  }
  for (let p = first; p <= last; p++) mountedPages.push(p);
  if (selectionPage !== null && selectionPage > last && selectionPage <= pageCount) {
    mountedPages.push(selectionPage);
  }

  const slots: React.ReactNode[] = [];
  const gutters: React.ReactNode[] = [];
  for (const p of mountedPages) {
    const i = p - 1;
    slots.push(
      <PageSlot
        key={p}
        doc={doc}
        page={p}
        top={layout.tops[i] ?? 0}
        width={layout.widths[i] ?? 0}
        height={layout.heights[i] ?? 0}
        scale={scale}
        quality={quality}
        hurried={hurried}
        pinching={pinching || columnTransitioning}
        isVisible={p >= visFirst && p <= visLast}
        containerWidth={containerWidth}
        reservedWidth={padRight}
        zoom={zoom}
        renderOverlays={renderOverlays}
      />,
    );
    if (renderGutter) {
      // The same numbers the slot above was placed with: the page is centred
      // in the scroller's content box, so its outer edge is half the column
      // plus half the page. The strip's width is the settled reserve, not the
      // animating one: the cards keep their size and slide in with the column
      // rather than re-wrapping word by word as it arrives.
      gutters.push(
        <div key={`gutter-${p}`} className="page-gutter-slot">
          {renderGutter(p, {
            top: layout.tops[i] ?? 0,
            left: `calc(50% + ${Math.round((layout.widths[i] ?? 0) / 2)}px)`,
            height: layout.heights[i] ?? 0,
            width: marginColumn ? COLUMN_PADDING : DOT_PADDING,
          })}
        </div>,
      );
    }
  }

  return (
    <div
      ref={bind}
      className="pdf-scroller preview-focusable"
      onScroll={onScroll}
      tabIndex={0}
      // The column's reserve, as the scroller's own padding: the page is laid
      // out in what is left, and the padding is transitioned (preview.css) so
      // the column arrives as the panel leaves.
      style={{
        paddingLeft: PAD_LEFT,
        paddingRight: marginColumn ? COLUMN_PADDING : DOT_PADDING,
      }}
    >
      <div className="pdf-scroller-column" style={{ height: layout.total, minWidth: widest }}>
        {slots}
        {gutters}
      </div>
    </div>
  );
}
