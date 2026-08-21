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

  // Clamped to the page. 6.2 stopped a region drag from running off the page's
  // edge, but only at the point where marks are made — every mark written by an
  // earlier build is still in the file, and an unclamped box draws outside its
  // page and over the neighbouring one. A rectangle that does not touch the
  // page at all comes back empty, which draws nothing.
  const left = clamp01(Math.min(ax, bx) / w);
  const right = clamp01(Math.max(ax, bx) / w);
  const top = clamp01(Math.min(ay, by) / h);
  const bottom = clamp01(Math.max(ay, by) / h);

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

/**
 * Place a rectangle measured from the page's TOP-left edge.
 *
 * PDF space has its origin at the bottom-left, and `pdfRectToBox` above expects
 * that: it is what `page_text_items` and link rectangles report. The reader's
 * MARKS are the other convention — `clientRectToPageRect` returns a top-left
 * origin because that is what `extract_region` takes — and drawing one through
 * the other flips it about the middle of the page.
 *
 * That is not a hypothetical. Every mark a reader made was drawn mirrored:
 * measured on a Letter page, a box dragged across the top tenth (5%–15% down)
 * appeared at 85%, and one dragged at 80%–92% appeared at 8%. Width, height and
 * horizontal position were all exactly right, which is what made it look like a
 * rendering quirk rather than a wrong coordinate system, and a box drawn
 * symmetrically about the middle of the page landed correctly — so it is
 * invisible in exactly the test one would write first.
 *
 * The conversion belongs here rather than in the store: marks already on disk
 * are in this convention, so a reader's existing notes come back in the right
 * place with no migration.
 */
export function topLeftRectToBox(
  rect: { x: number; y: number; width: number; height: number },
  geometry: PageGeometry,
): HighlightBox {
  const [viewLeft, viewBottom, , viewTop] = geometry.view;
  return pdfRectToBox(
    {
      x: rect.x + viewLeft,
      // `y` is the distance DOWN from the page's top edge to the rect's top;
      // PDF wants the distance UP from its bottom edge to the rect's bottom.
      y: viewTop - rect.y - rect.height,
      width: rect.width,
      height: rect.height,
    },
    geometry,
  );
  // viewBottom is unused deliberately: `pdfRectToBox` puts both corners through
  // the viewport transform, which already accounts for a non-zero lower edge.
  void viewBottom;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Boxes for every run on this page that contains the query. */
export function highlightBoxes(
  items: TextItemRect[],
  query: string,
  geometry: PageGeometry,
): HighlightBox[] {
  return matchingItems(items, query).map((item) => pdfRectToBox(item.rect, geometry));
}
