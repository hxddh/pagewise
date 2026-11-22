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

function sameRowBand(a: PdfRect, b: PdfRect): boolean {
  const tol = 0.65 * Math.max(a.height, b.height, 1);
  return Math.abs(a.y - b.y) <= tol;
}

function rowCellsAt(items: readonly TextItemRect[], ref: PdfRect): PdfRect[] {
  const row = items
    .map((it) => it.rect)
    .filter((r) => sameRowBand(r, ref))
    .sort((a, b) => a.x - b.x);
  if (row.length < 3) return [];
  const merged: PdfRect[] = [{ ...row[0]! }];
  for (let i = 1; i < row.length; i += 1) {
    const r = row[i]!;
    const prev = merged[merged.length - 1]!;
    if (r.x - (prev.x + prev.width) > 10) {
      merged.push({ ...r });
    } else {
      const right = Math.max(prev.x + prev.width, r.x + r.width);
      prev.x = Math.min(prev.x, r.x);
      prev.width = right - prev.x;
    }
  }
  return merged.length >= 3 && merged.every((c) => c.width < 180) ? merged : [];
}

/**
 * True only when `seedIndices` sit on a single row of a structured >=3-column
 * data table whose column x-starts align vertically with at least one adjacent
 * row — preventing cross-row figure bleed without truncating prose or metadata.
 */
function isSingleTableRowSeed(items: readonly TextItemRect[], seedIndices: ReadonlySet<number>): boolean {
  const seedRects = [...seedIndices].map((i) => items[i]!.rect);
  if (seedRects.length === 0) return false;
  const first = seedRects[0]!;
  if (!seedRects.every((r) => sameRowBand(r, first))) return false;
  const seedCols = rowCellsAt(items, first);
  if (seedCols.length < 3) return false;

  const h = Math.max(1, ...seedRects.map((r) => r.height));
  const neighborSeeds: PdfRect[] = [];
  for (const it of items) {
    if (sameRowBand(it.rect, first)) continue;
    if (Math.abs(it.rect.y - first.y) > h * 4.5) continue;
    if (neighborSeeds.some((n) => sameRowBand(n, it.rect))) continue;
    neighborSeeds.push(it.rect);
  }
  return neighborSeeds.some((n) => {
    const otherCols = rowCellsAt(items, n);
    if (otherCols.length !== seedCols.length) return false;
    return seedCols.every((c, idx) => Math.abs(c.x - otherCols[idx]!.x) <= 24);
  });
}

export function passageAround(items: readonly TextItemRect[], rects: readonly PdfRect[]): string {
  const inBlock = new Set<number>();
  items.forEach((it, i) => {
    if (rects.some((r) => intersects(it.rect, r))) inBlock.add(i);
  });
  if (inBlock.size === 0) return "";

  if (isSingleTableRowSeed(items, inBlock)) {
    const seedRect = items[[...inBlock][0]!]!.rect;
    items.forEach((it, i) => {
      if (inBlock.size >= MAX_RUNS) return;
      if (sameRowBand(it.rect, seedRect)) inBlock.add(i);
    });
    return [...inBlock]
      .map((i) => items[i]!)
      .sort((a, b) => b.rect.y - a.rect.y || a.rect.x - b.rect.x)
      .map((it) => it.text)
      .join(" ");
  }

  const seedHeights = [...inBlock].map((i) => items[i]!.rect.height).filter((h) => h > 0);
  const seedMedianHeight =
    seedHeights.length > 0
      ? [...seedHeights].sort((a, b) => a - b)[Math.floor(seedHeights.length / 2)]!
      : 0;

  let grew = true;
  while (grew && inBlock.size < MAX_RUNS) {
    grew = false;
    const block = [...inBlock].map((i) => items[i]!.rect);
    const left = Math.min(...block.map((r) => r.x));
    const right = Math.max(...block.map((r) => r.x + r.width));
    const minY = Math.min(...block.map((r) => r.y));
    const lineHeight = Math.max(...block.map((r) => r.height));
    items.forEach((it, i) => {
      if (inBlock.has(i) || inBlock.size >= MAX_RUNS) return;
      if (!overlapsX(it.rect, left, right)) return;
      const onExistingLine = block.some((r) => sameRowBand(r, it.rect));
      if (!onExistingLine && seedMedianHeight > 0 && it.rect.height > 0) {
        // Stop vertical growth across a sharp font-size step (body -> footnote or heading).
        const ratio = Math.min(seedMedianHeight, it.rect.height) / Math.max(seedMedianHeight, it.rect.height);
        if (ratio < 0.84) return;
        if (
          it.rect.y < minY &&
          it.rect.height < seedMedianHeight * 0.94 &&
          /^(?:\*+|†|‡|§|Footnote\b|Notes?:|注[：:])/i.test(it.text.trim())
        ) {
          return;
        }
      }
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

/**
 * The most of a page's text a model review is sent (22.0): the passage it
 * reads when the quoted words were not found, so there is no paragraph to
 * send. About a page of prose. A longer page is not sent at all: cut short,
 * the model could read support in its first half that a condition in the
 * second takes back (Codex on #157).
 */
export const MAX_PAGE_TEXT = 4000;

/** A page's runs as text, in the order the page gives them; null past `MAX_PAGE_TEXT`. */
export function pageText(items: readonly TextItemRect[]): string | null {
  const text = items
    .map((it) => it.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= MAX_PAGE_TEXT ? text : null;
}
