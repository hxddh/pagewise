import type { PageGeometry } from "../../lib/pdf";
import type { TextItemRect } from "../../lib/types";

/**
 * A highlight box as fractions of the page, measured from its top-left.
 *
 * Fractions rather than pixels so the boxes track zoom, window resizes and
 * device pixel ratio without anyone recomputing them.
 */
export interface HighlightBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Cap the boxes drawn for one page — a one-letter query matches everything. */
const MAX_BOXES = 60;

/**
 * Which text runs on this page contain the query.
 *
 * Matching is per run, and runs are lines: a phrase broken across two lines
 * matches neither. That is a real limit of what the extractor reports, and it
 * degrades to "no highlight" rather than to a wrong one.
 */
export function matchingItems(items: TextItemRect[], query: string): TextItemRect[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const out: TextItemRect[] = [];
  for (const item of items) {
    if (item.text.toLowerCase().includes(needle)) {
      out.push(item);
      if (out.length >= MAX_BOXES) break;
    }
  }
  return out;
}

/**
 * Place a rectangle reported in PDF points onto the rendered page.
 *
 * The page may carry an intrinsic rotation, so both corners go through the
 * viewport transform and are normalized afterwards — the same reason
 * `clientRectToPageRect` does it in the other direction.
 */
export function pdfRectToBox(
  rect: { x: number; y: number; width: number; height: number },
  geometry: PageGeometry,
): HighlightBox {
  const w = geometry.viewportWidth > 0 ? geometry.viewportWidth : 1;
  const h = geometry.viewportHeight > 0 ? geometry.viewportHeight : 1;
  const [ax, ay] = geometry.toViewportPoint(rect.x, rect.y);
  const [bx, by] = geometry.toViewportPoint(rect.x + rect.width, rect.y + rect.height);

  const left = Math.min(ax, bx);
  const right = Math.max(ax, bx);
  const top = Math.min(ay, by);
  const bottom = Math.max(ay, by);

  return {
    left: left / w,
    top: top / h,
    width: (right - left) / w,
    height: (bottom - top) / h,
  };
}

/** Boxes for every run on this page that contains the query. */
export function highlightBoxes(
  items: TextItemRect[],
  query: string,
  geometry: PageGeometry,
): HighlightBox[] {
  return matchingItems(items, query).map((item) => pdfRectToBox(item.rect, geometry));
}
