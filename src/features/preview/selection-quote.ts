import { extractRegion, getPageViewport } from "../../lib/pdf";
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
 * Convert a selection rectangle in screen pixels into PDF points.
 *
 * The text layer overlays the rendered page exactly, so its own box is the
 * page's box; the ratio between it and the page's width in points is the scale,
 * whatever zoom or device pixel ratio produced it. Both spaces put the origin
 * at the top-left, so no flip is involved.
 */
export function clientRectToPageRect(
  selection: ClientRect,
  pageBox: ClientRect,
  pageWidthPoints: number,
): PdfRect {
  const scale = pageBox.width > 0 ? pageWidthPoints / pageBox.width : 1;
  return {
    x: (selection.left - pageBox.left) * scale,
    y: (selection.top - pageBox.top) * scale,
    width: selection.width * scale,
    height: selection.height * scale,
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
    const viewport = await getPageViewport(path, page, 1);
    const rect = clientRectToPageRect(selection, pageBox, viewport.width);
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
