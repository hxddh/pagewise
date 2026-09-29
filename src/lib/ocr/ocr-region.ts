/**
 * The recognised words inside a rectangle the reader drew on a scan (14.0).
 *
 * On a page with a text layer the extractor reads a region; on a scan it has
 * nothing to read, and a region mark used to carry no text at all. OCR's
 * words do have positions, so the region's text is the words whose centres
 * fall inside it, in reading order.
 *
 * The rectangle arrives in the frame a mark is stored in — offset from the
 * page's visible box, top-left origin (`clientRectToPageRect`) — and the words
 * in absolute PDF space, bottom-left origin. `view` is what converts between
 * them.
 */
import type { PdfRect, TextItemRect } from "../types";
import { joinWords } from "./ocr-result";

export function wordsInRegion(
  items: readonly TextItemRect[],
  region: PdfRect,
  view: readonly [number, number, number, number],
): string {
  const [viewLeft, , , viewTop] = view;
  const left = region.x + viewLeft;
  const right = left + region.width;
  const top = viewTop - region.y;
  const bottom = top - region.height;

  const inside = items.filter((it) => {
    const cx = it.rect.x + it.rect.width / 2;
    const cy = it.rect.y + it.rect.height / 2;
    return cx >= left && cx <= right && cy >= bottom && cy <= top;
  });

  // Lines: words whose vertical centres are within half a word height of the
  // line's first word. Top to bottom, then left to right.
  const sorted = [...inside].sort((a, b) => b.rect.y + b.rect.height - (a.rect.y + a.rect.height));
  const lines: TextItemRect[][] = [];
  for (const w of sorted) {
    const cy = w.rect.y + w.rect.height / 2;
    const line = lines.find((l) => {
      const f = l[0]!;
      return Math.abs(f.rect.y + f.rect.height / 2 - cy) <= Math.max(f.rect.height, w.rect.height) / 2;
    });
    if (line) line.push(w);
    else lines.push([w]);
  }
  return lines
    .map((l) => l.sort((a, b) => a.rect.x - b.rect.x).reduce((acc, w) => joinWords(acc, w.text), ""))
    .join("\n");
}
