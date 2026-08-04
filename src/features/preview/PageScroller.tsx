import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { measurePageSizes } from "../../lib/pdf";
import type { LoadedDocument, PreviewQuality } from "../../lib/types";
import { PageSlot } from "./PageSlot";
import {
  fitWidthScale,
  layoutPages,
  offsetForPage,
  pageAtScroll,
  PAGE_GAP,
  visibleRange,
  type PageSize,
} from "./page-layout";

const SIDE_PADDING = 24;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
/** Below this, a scroll is treated as reading rather than seeking. */
const HURRY_PX_PER_TICK = 240;
const HURRY_IDLE_MS = 160;

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

  useEffect(() => {
    setSizes([]);
    let cancelled = false;
    void measurePageSizes(doc.path, pageCount, (next) => {
      if (!cancelled) setSizes(next);
    }, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [doc.path, pageCount]);

  const scale = useMemo(() => {
    if (zoom !== "fit-width") return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    if (containerWidth <= 0) return 1;
    return fitWidthScale(sizes, containerWidth, SIDE_PADDING);
  }, [zoom, sizes, containerWidth]);

  const layout = useMemo(
    () => layoutPages(sizes, pageCount, scale, PAGE_GAP),
    [sizes, pageCount, scale],
  );

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
      return () => ro.disconnect();
    },
    [containerRef],
  );

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
    setScrollTop(top);

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
    },
    [],
  );

  const { first, last } = visibleRange(layout, scrollTop, viewportHeight, 1);
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
      >
        {(state) => renderOverlays?.(p, state)}
      </PageSlot>,
    );
  }

  return (
    <div ref={bind} className="pdf-scroller preview-focusable" onScroll={onScroll} tabIndex={0}>
      <div className="pdf-scroller-column" style={{ height: layout.total }}>
        {slots}
      </div>
    </div>
  );
}
