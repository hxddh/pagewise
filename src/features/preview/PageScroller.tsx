import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { measurePages } from "../../lib/pdf";
import type { LoadedDocument, PreviewQuality } from "../../lib/types";
import { PageSlot } from "./PageSlot";
import type { PageMarginBox } from "./PageGutter";
import {
  fitWidthScale,
  layoutPages,
  offsetForPage,
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

interface PageScrollerProps {
  doc: LoadedDocument;
  /** 1-based page the rest of the app believes is current. */
  page: number;
  onPageChange: (page: number) => void;
  zoom: "fit-width" | number;
  quality: PreviewQuality;
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
export function PageScroller({
  doc,
  page,
  onPageChange,
  zoom,
  quality,
  marginColumn = false,
  renderOverlays,
  renderGutter,
  containerRef,
}: PageScrollerProps) {
  const pageCount = doc.kind === "pdf" ? Math.max(1, doc.totalPages) : 1;
  const [sizes, setSizes] = useState<Array<PageSize | undefined>>([]);
  const [containerWidth, setContainerWidth] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  // The scroller's right padding, read back from the computed style: it is
  // what the margin column reserves, and it is transitioned, so the value
  // mid-animation is the one the fit has to use.
  const [padRight, setPadRight] = useState(DOT_PADDING);
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
  //
  // The right padding is what the margin column reserves; the scroller carries
  // it as its own padding, so the page is laid out in what is left between the
  // two reserves and keeps its left edge whether the column is there or not.
  const scale = useMemo(() => {
    if (zoom !== "fit-width") return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    if (containerWidth <= 0) return 1;
    return fitWidthScale(sizes, containerWidth, { left: PAD_LEFT, right: padRight });
  }, [zoom, sizes, containerWidth, padRight]);

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
      // React 19 calls this cleanup instead of re-invoking the ref with null,
      // so anything holding the node has to be told here or it keeps pointing
      // at a node that has left the document.
      return () => {
        ro.disconnect();
        nodeRef.current = null;
        containerRef?.(null);
      };
    },
    [containerRef, readLayout],
  );

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
      const shift = scrollShiftForScale(prev.layout, layout, node.scrollTop);
      if (shift !== 0) {
        selfScrollRef.current = true;
        node.scrollTop += shift;
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
  const gutters: React.ReactNode[] = [];
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
