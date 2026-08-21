/**
 * Where each page sits in one continuously scrolling column.
 *
 * PageWise rendered one page at a time and flipped between them. A document is
 * read, not clicked through: a paragraph that crosses a page break, comparing
 * two facing numbers, or scanning for a figure all require the pages to be one
 * surface. All of that geometry lives here, as plain numbers, so the scroller
 * itself has no arithmetic in it.
 *
 * Units are CSS pixels at the current scale. Page 1 is index 0 throughout this
 * module; every page number crossing its boundary is 1-based, as everywhere
 * else in the app.
 */

/** A page's intrinsic size in PDF points (scale 1). */
export interface PageSize {
  width: number;
  height: number;
}

export interface PageLayout {
  /** Scrolltop of each page's top edge. */
  tops: number[];
  /** Rendered height of each page. */
  heights: number[];
  /** Rendered width of each page. */
  widths: number[];
  /** Height of the whole column, including the gap after the last page. */
  total: number;
}

/** Blank space between pages, so a page break is still visible. */
export const PAGE_GAP = 16;

/**
 * Stack pages top to bottom at `scale`.
 *
 * Sizes may be short or contain holes: a document's pages are measured lazily,
 * and until a page has been measured it stands in at the first known size.
 * A column that shifts under the reader as measurements land is worse than one
 * that is briefly approximate, so the fallback is deliberate rather than zero.
 */
export function layoutPages(
  sizes: ReadonlyArray<PageSize | undefined>,
  pageCount: number,
  scale: number,
  gap: number = PAGE_GAP,
): PageLayout {
  const fallback = sizes.find((s): s is PageSize => !!s) ?? { width: 612, height: 792 };
  const tops: number[] = [];
  const heights: number[] = [];
  const widths: number[] = [];
  let y = gap;
  for (let i = 0; i < pageCount; i++) {
    const size = sizes[i] ?? fallback;
    const h = Math.max(1, Math.round(size.height * scale));
    const w = Math.max(1, Math.round(size.width * scale));
    tops.push(y);
    heights.push(h);
    widths.push(w);
    y += h + gap;
  }
  return { tops, heights, widths, total: y };
}

/**
 * The page the reader is looking at.
 *
 * Three rules, in order.
 *
 * AT THE END OF THE COLUMN, the last page. There is no scroll left to bring a
 * later page forward, so without this the pages sharing the final screenful
 * could never take their turn — a document ending in a short page would report
 * the one before it while the reader stared at the last one.
 *
 * A PAGE YOU CAN SEE THE WHOLE OF is the page you are on, whatever share of the
 * screen its taller neighbours happen to take. This is what the rule below on
 * its own gets wrong: a page shorter than the viewport is covered by more of
 * its neighbour at every scroll position there is, so it could never be
 * current — the number jumped from 5 to 7 past a half-height page 6, and the
 * assistant was told the reader was on 7 while page 6 sat alone and complete in
 * the middle of the screen. Measured, not reasoned: see the note on the
 * round-trip test.
 *
 * OTHERWISE whichever page covers the most of the viewport — not whichever is
 * topmost. Scrolling a tall page's last inch into view should not yet count as
 * being on the next page.
 *
 * Together these make `pageAtScroll(layout, offsetForPage(layout, p), h) === p`
 * hold for every page at any height, which is what keeps navigating to a page
 * and reading the page number back from agreeing with each other.
 */
export function pageAtScroll(
  layout: PageLayout,
  scrollTop: number,
  viewportHeight: number,
): number {
  const count = layout.tops.length;
  if (count === 0) return 1;
  const height = Math.max(1, viewportHeight);
  const top = scrollTop;
  const bottom = scrollTop + height;

  // Only when the column actually scrolls: a document that fits on one screen
  // is at its end from the moment it opens, and opening it on the last page
  // would be absurd.
  if (layout.total > height && top >= layout.total - height - 1) return count;

  let best = -1;
  let bestOverlap = 0;
  for (let i = 0; i < count; i++) {
    const pageTop = layout.tops[i]!;
    const pageBottom = pageTop + layout.heights[i]!;
    if (pageTop >= bottom) break;
    if (pageBottom <= top) continue;
    // Top-down, so this is the FIRST page fully on screen — the one being read
    // rather than the one after it.
    if (pageTop >= top && pageBottom <= bottom) return i + 1;
    const overlap = Math.min(pageBottom, bottom) - Math.max(pageTop, top);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = i;
    }
  }
  // A scroll container cannot normally scroll past its content, but a stale
  // offset can arrive from a layout that just shrank. Answering "page 1" there
  // would send the outline, the thumbnails and the assistant's idea of the
  // current page back to the top of the document.
  if (best < 0) {
    const last = count - 1;
    return top >= (layout.tops[last] ?? 0) ? count : 1;
  }
  return best + 1;
}

/**
 * Pages to keep mounted: those on screen, plus `overscan` either side.
 *
 * Rendering only what is visible makes scrolling arrive at blank pages; the
 * neighbours are what make it arrive at drawn ones.
 */
export function visibleRange(
  layout: PageLayout,
  scrollTop: number,
  viewportHeight: number,
  overscan = 1,
): { first: number; last: number } {
  const count = layout.tops.length;
  if (count === 0) return { first: 1, last: 0 };
  const top = scrollTop;
  const bottom = scrollTop + Math.max(1, viewportHeight);
  let first = count - 1;
  let last = 0;
  let found = false;
  for (let i = 0; i < count; i++) {
    const pageTop = layout.tops[i]!;
    const pageBottom = pageTop + layout.heights[i]!;
    if (pageBottom <= top) continue;
    if (pageTop >= bottom) break;
    found = true;
    if (i < first) first = i;
    if (i > last) last = i;
  }
  // Scrolled past the end, or a layout not yet measured: keep something mounted
  // rather than blanking the view.
  if (!found) {
    const near = Math.min(count - 1, Math.max(0, pageAtScroll(layout, scrollTop, viewportHeight) - 1));
    first = near;
    last = near;
  }
  return {
    first: Math.max(1, first + 1 - overscan),
    last: Math.min(count, last + 1 + overscan),
  };
}

/**
 * How far the scroll has to move to keep the reader where they were when the
 * column reflows under them.
 *
 * Pages are measured lazily and stand in at the first known size until they
 * are. Jump to page 50 and everything between page 2 and page 42 is still
 * standing in at page 1's height; scroll back up and each one is measured for
 * the first time as it comes into range, and every page below it — including
 * the one being read — moves by the difference. Measured on a sixty-page
 * document with mixed page heights: the text under the reader leapt 1,110px,
 * more than a full screen, and then 488px again.
 *
 * The correction is the shift of the page the reader is on. Moving the scroll
 * by exactly that keeps both the page and the position within it fixed, so the
 * reflow happens entirely off screen — which is what a reader should never have
 * to notice.
 *
 * Returns 0 when the two layouts are not comparable (a different document, a
 * different scale), because then there is no "same place" to hold.
 */
export function scrollShiftForRelayout(
  prev: PageLayout,
  next: PageLayout,
  scrollTop: number,
  viewportHeight: number,
): number {
  if (prev === next) return 0;
  if (prev.tops.length !== next.tops.length || prev.tops.length === 0) return 0;
  const anchor = pageAtScroll(prev, scrollTop, viewportHeight);
  const before = prev.tops[anchor - 1];
  const after = next.tops[anchor - 1];
  if (before === undefined || after === undefined) return 0;
  const shift = after - before;
  // Never scroll above the top of the document to honour a shift.
  return Math.max(-scrollTop, shift);
}

/** Scrolltop that puts `page` at the top of the viewport. */
export function offsetForPage(layout: PageLayout, page: number, gap: number = PAGE_GAP): number {
  const i = Math.min(layout.tops.length - 1, Math.max(0, page - 1));
  if (i < 0) return 0;
  return Math.max(0, (layout.tops[i] ?? 0) - gap);
}

/**
 * Scale that fits the widest known page into `containerWidth`.
 *
 * The widest rather than the current one: a landscape page mid-document must
 * not force the column to reflow every page around it as the reader passes.
 */
export function fitWidthScale(
  sizes: ReadonlyArray<PageSize | undefined>,
  containerWidth: number,
  padding: number,
): number {
  const usable = Math.max(1, containerWidth - padding * 2);
  let widest = 0;
  for (const size of sizes) {
    if (size && size.width > widest) widest = size.width;
  }
  if (widest <= 0) return 1;
  return usable / widest;
}
