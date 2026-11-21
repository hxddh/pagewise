import { extractRegion, getPageGeometry, type PageGeometry } from "../../lib/pdf";
import type { PdfRect } from "../../lib/types";
import type { PageSelectionSlice } from "./useAskSelection";

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
function sliceEnvelope(rects: readonly ClientRect[]): ClientRect | null {
  if (rects.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.left + r.width);
    bottom = Math.max(bottom, r.top + r.height);
  }
  const width = right - left;
  const height = bottom - top;
  return width > 0 && height > 0 ? { left, top, width, height } : null;
}

export async function selectionQuote(
  path: string,
  page: number,
  domText: string,
  selection: ClientRect,
  pageBox: ClientRect | null,
  pages?: PageSelectionSlice[],
): Promise<string> {
  if (pages && pages.length > 1) {
    try {
      const parts = await Promise.all(
        pages.map(async (slice) => {
          const env = sliceEnvelope(slice.rects);
          if (!env || slice.pageBox.width <= 0) return "";
          const geometry = await getPageGeometry(path, slice.page);
          const rect = clientRectToPageRect(env, slice.pageBox, geometry);
          if (rect.width <= 0 || rect.height <= 0) return "";
          const region = await extractRegion(path, slice.page, rect);
          if (region.table?.trim()) return region.table.trim();
          if (region.latex?.trim()) return `$${region.latex.trim()}$`;
          return region.text.trim();
        }),
      );
      const hasStructured = parts.some((p) => p.includes("|---") || p.startsWith("$"));
      if (hasStructured) {
        const joined = parts.filter(Boolean).join("\n\n").trim();
        if (joined) return truncate(joined);
      }
      return truncate(domText);
    } catch {
      return truncate(domText);
    }
  }

  if (!pageBox || pageBox.width <= 0) return truncate(domText);
  try {
    const geometry = await getPageGeometry(path, page);
    const rect = clientRectToPageRect(selection, pageBox, geometry);
    if (rect.width <= 0 || rect.height <= 0) return truncate(domText);

    const region = await extractRegion(path, page, rect);
    // A table or reconstructed LaTeX formula is worth quoting verbatim; plain
    // prose is not obviously better than what the user visibly selected.
    if (region.table?.trim()) return truncate(region.table.trim());
    if (region.latex?.trim()) return truncate(`$${region.latex.trim()}$`);
    return truncate(domText);
  } catch {
    return truncate(domText);
  }
}
