import { useEffect, useState, type RefObject } from "react";

export interface AskSelection {
  text: string;
  /** Viewport px: horizontal center and top of the selection rect. */
  x: number;
  y: number;
  /** The selection's box in viewport px, for re-reading the region it covers. */
  rect: { left: number; top: number; width: number; height: number };
  /** One box per line of the selection, for drawing it. See `lineRects`. */
  rects: { left: number; top: number; width: number; height: number }[];
  /** 1-based page the selection is on. */
  page: number;
  /** That page's box in viewport px, which every rect is measured against. */
  pageBox: { left: number; top: number; width: number; height: number };
}

const MAX_QUOTE = 500;
type ClientRectLike = { left: number; top: number; width: number; height: number };

/** The page element a node sits in, or null when it is outside every page. */
function slotOf(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  return el?.closest<HTMLElement>(".pdf-page-slot[data-page]") ?? null;
}

/** Ignore sub-pixel client rects — a collapsed run between two lines. */
const MIN_LINE_RECT = 1;
/** A selection wider than a page is a stray drag, not a passage. */
const MAX_LINE_RECTS = 200;

/**
 * The selection line by line, rather than as one box.
 *
 * A three-line selection's bounding box also covers the first line's left
 * margin and the last line's right margin — drawn as a highlight it is a slab
 * over the paragraph rather than over the words. `getClientRects` reports the
 * per-line boxes the browser already computed, so the right shape costs a loop.
 */
export function lineRects(range: Pick<Range, "getClientRects">, fallback: ClientRectLike): AskSelection["rects"] {
  const rects = Array.from(range.getClientRects())
    .filter((r) => r.width > MIN_LINE_RECT && r.height > MIN_LINE_RECT)
    .slice(0, MAX_LINE_RECTS)
    .map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height }));
  if (rects.length > 0) return rects;
  return [
    { left: fallback.left, top: fallback.top, width: fallback.width, height: fallback.height },
  ];
}

/**
 * Track a non-empty text selection inside `containerRef` (the PDF text layer's
 * scroll container) and expose its trimmed text + a viewport position, so a
 * floating "ask about this" affordance can be shown. Returns the current
 * selection (or null) and a clear function.
 */
export function useAskSelection<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  enabled: boolean,
): [AskSelection | null, () => void] {
  const [sel, setSel] = useState<AskSelection | null>(null);

  useEffect(() => {
    if (!enabled) {
      setSel(null);
      return;
    }
    const update = () => {
      const s = window.getSelection();
      const container = containerRef.current;
      if (!s || s.isCollapsed || !container) return setSel(null);
      const { anchorNode, focusNode } = s;
      if (
        !anchorNode ||
        !focusNode ||
        !container.contains(anchorNode) ||
        !container.contains(focusNode)
      ) {
        return setSel(null);
      }
      const text = s.toString().replace(/\s+/g, " ").trim();
      if (text.length < 2) return setSel(null);
      // With every page on one scrolling surface, a rectangle only means
      // something against the page it is on — so the page has to come out of
      // the selection rather than from whatever the app calls "current".
      const slot = slotOf(anchorNode);
      if (!slot) return setSel(null);
      const pageAttr = Number(slot.dataset.page);
      if (!Number.isInteger(pageAttr) || pageAttr < 1) return setSel(null);
      const slotBox = slot.getBoundingClientRect();
      const range = s.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return setSel(null);
      setSel({
        text: text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}…` : text,
        x: rect.left + rect.width / 2,
        y: rect.top,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        rects: lineRects(range, rect),
        page: pageAttr,
        pageBox: {
          left: slotBox.left,
          top: slotBox.top,
          width: slotBox.width,
          height: slotBox.height,
        },
      });
    };
    // selectionchange fires rapidly during a drag; coalesce to one rAF.
    let raf = 0;
    const onChange = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    document.addEventListener("selectionchange", onChange);
    // Scrolling does not fire selectionchange, and these are viewport
    // coordinates: while the preview flipped, a selection could not move once
    // made, so computing its position once was computing it forever. On a
    // scrolling surface the passage slides away and the buttons anchored to it
    // stay pinned to the window. Scroll events do not bubble, so this listens
    // in the capture phase to hear the preview's own container.
    window.addEventListener("scroll", onChange, true);
    window.addEventListener("resize", onChange);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("selectionchange", onChange);
      window.removeEventListener("scroll", onChange, true);
      window.removeEventListener("resize", onChange);
    };
  }, [containerRef, enabled]);

  return [sel, () => setSel(null)];
}
