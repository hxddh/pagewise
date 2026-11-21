import type { PageGeometry } from "../../lib/pdf";
import { locateQuote } from "../../lib/quote-locate";
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
  const needle = query.trim().normalize("NFKC").toLowerCase();
  if (!needle) return [];
  const out: TextItemRect[] = [];
  for (const item of items) {
    if (item.text.normalize("NFKC").toLowerCase().includes(needle)) {
      out.push(item);
      if (out.length >= MAX_BOXES) break;
    }
  }
  if (out.length === 0) {
    const located = locateQuote(items, query);
    if (located.status === "located" && located.items.length >= 2) {
      const firstY = located.items[0]!.rect.y;
      const spansLines = located.items.some((it) => Math.abs(it.rect.y - firstY) > 2);
      if (spansLines) return located.items.slice(0, MAX_BOXES);
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

export interface HighlightOccurrence {
  box: HighlightBox;
  /** 0-based match ordinal on the page, matching `DocumentSearch` hit order. */
  occurrence: number;
}

function subRectForSlice(
  rect: { x: number; y: number; width: number; height: number },
  start: number,
  end: number,
  total: number,
): { x: number; y: number; width: number; height: number } {
  if (total <= 0 || (start <= 0 && end >= total)) return rect;
  const f0 = Math.max(0, Math.min(1, start / total));
  const f1 = Math.max(f0, Math.min(1, end / total));
  if (rect.height > rect.width * 1.5) {
    const span = Math.max(rect.width * 0.4, (f1 - f0) * rect.height);
    return {
      x: rect.x,
      y: rect.y + (1 - f1) * rect.height,
      width: rect.width,
      height: Math.min(rect.height, span),
    };
  }
  const span = Math.max(rect.height * 0.35, (f1 - f0) * rect.width);
  const x = rect.x + f0 * rect.width;
  return {
    x,
    y: rect.y,
    width: Math.min(rect.x + rect.width - x, span),
    height: rect.height,
  };
}

/**
 * Occurrence-level highlight boxes for `query` on one page: a text run containing
 * two matches produces two distinct boxes (`occurrence: 0` and `occurrence: 1`)
 * so `Enter` / `⇧Enter` / `⌘G` steps accurately within multi-match runs instead
 * of jumping ahead to a later run.
 */
export function highlightOccurrences(
  items: TextItemRect[],
  query: string,
  geometry: PageGeometry,
): HighlightOccurrence[] {
  const needle = query.trim().normalize("NFKC").toLowerCase();
  if (!needle) return [];

  const out: HighlightOccurrence[] = [];
  let occ = 0;
  for (const item of items) {
    const norm = item.text.normalize("NFKC").toLowerCase();
    let from = 0;
    while (from <= norm.length - needle.length) {
      const at = norm.indexOf(needle, from);
      if (at < 0) break;
      const sub = subRectForSlice(item.rect, at, at + needle.length, norm.length);
      out.push({ box: pdfRectToBox(sub, geometry), occurrence: occ });
      occ += 1;
      if (out.length >= MAX_BOXES) return out;
      from = at + Math.max(1, needle.length);
    }
  }

  if (out.length === 0) {
    const located = locateQuote(items, query);
    if (located.status === "located" && located.items.length >= 2) {
      const firstY = located.items[0]!.rect.y;
      const spansLines = located.items.some((it) => Math.abs(it.rect.y - firstY) > 2);
      if (spansLines) {
        for (const it of located.items.slice(0, MAX_BOXES)) {
          out.push({ box: pdfRectToBox(it.rect, geometry), occurrence: 0 });
        }
      }
    }
  }
  return out;
}

/** Boxes for every occurrence on this page that matches `query`. */
export function highlightBoxes(
  items: TextItemRect[],
  query: string,
  geometry: PageGeometry,
): HighlightBox[] {
  return highlightOccurrences(items, query, geometry).map((o) => o.box);
}
