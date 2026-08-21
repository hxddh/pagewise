import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { measurePages } from "../../lib/pdf";
import type { LoadedDocument, PreviewQuality } from "../../lib/types";
import { PageSlot } from "./PageSlot";
import {
  fitWidthScale,
  layoutPages,
  offsetForPage,
  pageAtScroll,
  PAGE_GAP,
  scrollShiftForRelayout,
  visibleRange,
  type PageSize,
} from "./page-layout";

const SIDE_PADDING = 24;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
/** Below this, a scroll is treated as reading rather than seeking. */
const HURRY_PX_PER_TICK = 240;
const HURRY_IDLE_MS = 160;
/** Pages measured either side of the mounted window, so the layout runs ahead. */
const MEASURE_MARGIN = 8;

interface PageScrollerProps {
  doc: LoadedDocument;
  /** 1-based page the rest of the app believes is current. */
  page: number;
  onPageChange: (page: number) => void;
  zoom: "fit-width" | number;
  quality: PreviewQuality;
  /** Rendered inside each page, positioned against that page. */
  renderOverlays?: (page: number, state: { textLayerActive: boolean }) => React.ReactNode;
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
export function PageScroller({
  doc,
  page,
  onPageChange,
  zoom,
  quality,
  renderOverlays,
  containerRef,
}: PageScrollerProps) {
  const pageCount = doc.kind === "pdf" ? Math.max(1, doc.totalPages) : 1;
  const [sizes, setSizes] = useState<Array<PageSize | undefined>>([]);
  const [containerWidth, setContainerWidth] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [hurried, setHurried] = useState(false);

  const nodeRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  // Set while this component is scrolling itself to a page, so the scroll it
  // causes is not read back as the reader having navigated.
  const selfScrollRef = useRef(false);
  const lastScrollRef = useRef(0);
  const hurryTimerRef = useRef<number | undefined>(undefined);
  const rafRef = useRef<number | undefined>(undefined);
  // Pages asked for, and pages whose answer came back. A window abandoned
  // mid-flight has to leave its unanswered pages askable again, or scrolling
  // quickly past them would strand them at the fallback size forever.
  const requestedRef = useRef<Set<number>>(new Set());
  const measuredRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    requestedRef.current = new Set();
    measuredRef.current = new Set();
    setSizes([]);
  }, [doc.path, pageCount]);

  // Fit-width fits the widest page measured so far, so arriving at a landscape
  // page mid-document narrows the column once. Measuring every page up front to
  // avoid that costs an unbounded chain of `getPage` on every open, for pages
  // most readers never reach — the one reflow is the cheaper of the two.
  const scale = useMemo(() => {
    if (zoom !== "fit-width") return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    if (containerWidth <= 0) return 1;
    return fitWidthScale(sizes, containerWidth, SIDE_PADDING);
  }, [zoom, sizes, containerWidth]);

  const layout = useMemo(
    () => layoutPages(sizes, pageCount, scale, PAGE_GAP),
    [sizes, pageCount, scale],
  );

  // Zoomed past the container width, the column has to be as wide as its
  // widest page or the half of that page hanging off centre is unreachable.
  const widest = layout.widths.length > 0 ? Math.max(...layout.widths) : 0;

  const { first, last } = visibleRange(layout, scrollTop, viewportHeight, 1);

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

  const bind = useCallback(
    (node: HTMLDivElement | null) => {
      nodeRef.current = node;
      containerRef?.(node);
      if (!node) return;
      setContainerWidth(node.clientWidth);
      setViewportHeight(node.clientHeight);
      const ro = new ResizeObserver(() => {
        setContainerWidth(node.clientWidth);
        setViewportHeight(node.clientHeight);
      });
      ro.observe(node);
      // React 19 calls this cleanup instead of re-invoking the ref with null,
      // so anything holding the node has to be told here or it keeps pointing
      // at a node that has left the document.
      return () => {
        ro.disconnect();
        nodeRef.current = null;
        containerRef?.(null);
      };
    },
    [containerRef],
  );

  // Hold the reader's place when the column reflows under them.
  //
  // Pages are measured as the reader reaches them, so scrolling back up through
  // a stretch that was jumped over measures each page for the first time and
  // moves everything below it — including the paragraph being read. This runs
  // before the page-sync effect below so that effect sees the corrected scroll
  // and has nothing left to do.
  //
  // A scale change is excluded: zoom is meant to re-anchor to the page, and the
  // effect below already does that.
  const relayoutRef = useRef({ layout, scale });
  useLayoutEffect(() => {
    const node = nodeRef.current;
    const prev = relayoutRef.current;
    relayoutRef.current = { layout, scale };
    if (!node || prev.scale !== scale) return;
    const shift = scrollShiftForRelayout(prev.layout, layout, node.scrollTop, node.clientHeight);
    if (shift === 0) return;
    selfScrollRef.current = true;
    node.scrollTop += shift;
    setScrollTop(node.scrollTop);
    requestAnimationFrame(() => {
      selfScrollRef.current = false;
    });
  }, [layout, scale]);

  // Bring the view to a page the rest of the app navigated to (outline click,
  // a citation, the page box). Scrolling here must not echo back as a page
  // change, or the two would fight.
  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node || layout.tops.length === 0) return;
    const current = pageAtScroll(layout, node.scrollTop, node.clientHeight);
    if (current === page) return;
    selfScrollRef.current = true;
    node.scrollTop = offsetForPage(layout, page);
    setScrollTop(node.scrollTop);
    // Cleared on the next frame: the scroll event this caused lands first.
    requestAnimationFrame(() => {
      selfScrollRef.current = false;
    });
  }, [page, layout]);

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

    const jump = Math.abs(top - lastScrollRef.current);
    lastScrollRef.current = top;
    if (jump > HURRY_PX_PER_TICK) setHurried(true);
    window.clearTimeout(hurryTimerRef.current);
    hurryTimerRef.current = window.setTimeout(() => setHurried(false), HURRY_IDLE_MS);

    if (selfScrollRef.current) return;
    const next = pageAtScroll(layout, top, node.clientHeight);
    if (next !== pageRef.current) onPageChange(next);
  }, [layout, onPageChange]);

  useEffect(
    () => () => {
      window.clearTimeout(hurryTimerRef.current);
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const slots: React.ReactNode[] = [];
  for (let p = first; p <= last; p++) {
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
        containerWidth={containerWidth}
        zoom={zoom}
        renderOverlays={renderOverlays}
      />,
    );
  }

  return (
    <div ref={bind} className="pdf-scroller preview-focusable" onScroll={onScroll} tabIndex={0}>
      <div
        className="pdf-scroller-column"
        style={{ height: layout.total, minWidth: widest + SIDE_PADDING * 2 }}
      >
        {slots}
      </div>
    </div>
  );
}
