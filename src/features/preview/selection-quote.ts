import { extractRegion, getPageGeometry, type PageGeometry } from "../../lib/pdf";
import type { PdfRect } from "../../lib/types";

/** Cap a quote so a large selection cannot flood the composer. */
export const MAX_QUOTE = 500;

export interface ClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Convert a selection rectangle in screen pixels into the page's own points.
 *
 * The text layer overlays the rendered page exactly, so its box is the page's
 * box and the ratio between them is the scale — whatever zoom or device pixel
 * ratio produced it. Beyond that, nothing about the screen's axes can be
 * assumed: a `/Rotate 90` page is painted turned, and the text layer with it,
 * so the corners go through the viewport's own transform rather than a
 * width-only ratio. Both corners are converted and then normalized, since
 * rotation can swap which one ends up on top.
 *
 * The result uses a top-left origin, matching what `extract_region` expects.
 */
export function clientRectToPageRect(
  selection: ClientRect,
  pageBox: ClientRect,
  geometry: PageGeometry,
): PdfRect {
  const scale = pageBox.width > 0 ? geometry.viewportWidth / pageBox.width : 1;
  const x1 = (selection.left - pageBox.left) * scale;
  const y1 = (selection.top - pageBox.top) * scale;
  const x2 = x1 + selection.width * scale;
  const y2 = y1 + selection.height * scale;

  const [ax, ay] = geometry.toPdfPoint(x1, y1);
  const [bx, by] = geometry.toPdfPoint(x2, y2);
  const [viewLeft, , , viewTop] = geometry.view;

  const left = Math.min(ax, bx);
  const right = Math.max(ax, bx);
  const bottom = Math.min(ay, by);
  const top = Math.max(ay, by);

  return {
    x: left - viewLeft,
    y: viewTop - top,
    width: right - left,
    height: top - bottom,
  };
}

function truncate(text: string): string {
  return text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}…` : text;
}

/**
 * Prefer the structured text under a selection over the text layer's own.
 *
 * Selecting across a table through the DOM yields its cells run together —
 * `营业收入 1,2841,141` — which is exactly the ambiguity the extractor exists to
 * remove. Re-reading the selected region gives back the table as a table.
 *
 * Falls back to the DOM text on any failure: this path is an improvement to an
 * interaction that already works, and must never be the reason it stops.
 */
export async function selectionQuote(
  path: string,
  page: number,
  domText: string,
  selection: ClientRect,
  pageBox: ClientRect | null,
): Promise<string> {
  if (!pageBox || pageBox.width <= 0) return truncate(domText);
  try {
    const geometry = await getPageGeometry(path, page);
    const rect = clientRectToPageRect(selection, pageBox, geometry);
    if (rect.width <= 0 || rect.height <= 0) return truncate(domText);

    const region = await extractRegion(path, page, rect);
    // A table is worth quoting verbatim; prose is not obviously better than
    // what the user visibly selected, so leave that alone.
    if (region.table?.trim()) return truncate(region.table.trim());
    return truncate(domText);
  } catch {
    return truncate(domText);
  }
}
