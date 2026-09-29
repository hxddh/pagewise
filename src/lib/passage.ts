/**
 * The passage a located quote sits in (15.0).
 *
 * A sentence's numbers are compared with the passage, not with the quote: a
 * model quotes the phrase that proves the point ("按逾期金额的万分之三") and
 * states the figure from the words around it ("每日"). Too narrow a context
 * flags correct sentences; too wide a one (the whole page) lets a wrong number
 * pass because it appears in another clause. The paragraph is where a reader
 * would look.
 *
 * Built from the page's own runs: the runs the quote was found in, grown by
 * any run just above or below that shares their column, until a gap wider than
 * a line and a half ends the paragraph. A table grows into the whole table,
 * which only ever makes the check more forgiving.
 */
import type { PdfRect, TextItemRect } from "./types";

const MAX_RUNS = 60;

function intersects(a: PdfRect, b: PdfRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function overlapsX(a: PdfRect, left: number, right: number): boolean {
  return a.x < right && a.x + a.width > left;
}

export function passageAround(items: readonly TextItemRect[], rects: readonly PdfRect[]): string {
  const inBlock = new Set<number>();
  items.forEach((it, i) => {
    if (rects.some((r) => intersects(it.rect, r))) inBlock.add(i);
  });
  if (inBlock.size === 0) return "";

  let grew = true;
  while (grew && inBlock.size < MAX_RUNS) {
    grew = false;
    const block = [...inBlock].map((i) => items[i]!.rect);
    const left = Math.min(...block.map((r) => r.x));
    const right = Math.max(...block.map((r) => r.x + r.width));
    const lineHeight = Math.max(...block.map((r) => r.height));
    items.forEach((it, i) => {
      if (inBlock.has(i) || inBlock.size >= MAX_RUNS) return;
      if (!overlapsX(it.rect, left, right)) return;
      const near = block.some((r) => {
        const gap = Math.max(r.y - (it.rect.y + it.rect.height), it.rect.y - (r.y + r.height));
        return gap <= 1.5 * Math.max(lineHeight, it.rect.height);
      });
      if (near) {
        inBlock.add(i);
        grew = true;
      }
    });
  }
  // Top to bottom, left to right: the reading order of a paragraph.
  return [...inBlock]
    .map((i) => items[i]!)
    .sort((a, b) => b.rect.y - a.rect.y || a.rect.x - b.rect.x)
    .map((it) => it.text)
    .join(" ");
}
