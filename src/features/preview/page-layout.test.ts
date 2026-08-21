import { describe, expect, it } from "vitest";
import {
  fitWidthScale,
  layoutPages,
  offsetForPage,
  pageAtScroll,
  PAGE_GAP,
  scrollShiftForRelayout,
  visibleRange,
  type PageSize,
} from "./page-layout";

const A4: PageSize = { width: 600, height: 800 };

function uniform(count: number, size: PageSize = A4) {
  return Array.from({ length: count }, () => size);
}

describe("layoutPages", () => {
  it("stacks pages with a gap above each one", () => {
    const l = layoutPages(uniform(3), 3, 1, 10);
    expect(l.tops).toEqual([10, 820, 1630]);
    expect(l.heights).toEqual([800, 800, 800]);
    expect(l.total).toBe(2440);
  });

  it("scales heights and widths together", () => {
    const l = layoutPages(uniform(2), 2, 0.5, 0);
    expect(l.heights).toEqual([400, 400]);
    expect(l.widths).toEqual([300, 300]);
  });

  it("stands an unmeasured page in at the first known size", () => {
    // Pages are measured lazily; a column that reflows under the reader as
    // measurements land is worse than one that is briefly approximate.
    const sizes = [A4, undefined, { width: 600, height: 400 }];
    const l = layoutPages(sizes, 3, 1, 0);
    expect(l.heights).toEqual([800, 800, 400]);
  });

  it("falls back to Letter when nothing has been measured yet", () => {
    const l = layoutPages([], 2, 1, 0);
    expect(l.heights).toEqual([792, 792]);
  });

  it("never gives a page zero height", () => {
    const l = layoutPages([{ width: 1, height: 1 }], 1, 0.0001, 0);
    expect(l.heights[0]).toBeGreaterThan(0);
  });
});

describe("pageAtScroll", () => {
  const layout = layoutPages(uniform(4), 4, 1, 10);

  it("is page 1 at the top", () => {
    expect(pageAtScroll(layout, 0, 600)).toBe(1);
  });

  it("takes the page covering the most of the viewport, not the topmost", () => {
    // Page 1's last 50px are on screen; page 2 covers the other 550.
    expect(pageAtScroll(layout, 760, 600)).toBe(2);
  });

  it("still reports the tall page while only its tail is showing", () => {
    // 40px of page 2 left, nothing else yet — page 2 it is.
    const tall = layoutPages([A4, { width: 600, height: 4000 }, A4], 3, 1, 10);
    expect(pageAtScroll(tall, 4770, 60)).toBe(2);
  });

  it("clamps to the last page past the end", () => {
    expect(pageAtScroll(layout, 99_999, 600)).toBe(4);
  });

  it("says page 1 for an empty layout rather than 0", () => {
    expect(pageAtScroll(layoutPages([], 0, 1), 0, 600)).toBe(1);
  });

  it("takes a page it can see the whole of over a taller neighbour", () => {
    // The defect this rule exists for. A page shorter than the viewport is
    // covered by more of its neighbour at EVERY scroll position there is, so
    // under max-overlap alone it could never be current at all.
    const short = layoutPages([A4, { width: 600, height: 200 }, A4], 3, 1, 10);
    // Viewport [810, 1410]: page 2 sits alone and complete at [820, 1020];
    // page 3 takes [1030, 1410] — 380px against page 2's 200.
    expect(pageAtScroll(short, 810, 600)).toBe(2);
  });

  it("is the last page at the end of the column, even when that page is short", () => {
    // There is no scroll left to bring it forward, so without this it could
    // never take its turn: the reader stares at the final page and the toolbar,
    // the thumbnails and the assistant all say the one before it.
    const l = layoutPages([A4, A4, { width: 600, height: 150 }], 3, 1, 10);
    expect(pageAtScroll(l, l.total - 600, 600)).toBe(3);
  });

  it("does not open a one-screen document on its last page", () => {
    // A document that fits entirely on screen is at its end from the moment it
    // opens; the end-of-column rule must not fire there.
    const l = layoutPages([{ width: 600, height: 200 }, { width: 600, height: 200 }], 2, 1, 10);
    expect(pageAtScroll(l, 0, 900)).toBe(1);
  });

  it("never skips a page while the reader scrolls from top to bottom", () => {
    // Measured in the browser before it was written down: on a ten-page
    // document with one half-height page, the toolbar counted
    // 1 2 3 4 5 7 8 9 10 — page 6 did not exist as somewhere you could be.
    const sizes: PageSize[] = [
      { width: 600, height: 800 },
      { width: 600, height: 300 },
      { width: 600, height: 800 },
      { width: 1000, height: 600 },
      { width: 600, height: 800 },
      { width: 600, height: 250 },
      { width: 600, height: 800 },
      { width: 600, height: 800 },
      { width: 600, height: 1200 },
      { width: 600, height: 260 },
    ];
    const l = layoutPages(sizes, sizes.length, 1, PAGE_GAP);
    const viewport = 860;
    const seen: number[] = [];
    for (let top = 0; top <= l.total - viewport; top += 20) {
      const page = pageAtScroll(l, top, viewport);
      if (seen[seen.length - 1] !== page) seen.push(page);
    }
    for (let page = 1; page <= sizes.length; page += 1) {
      expect(seen, `page ${page} must be somewhere the reader can be`).toContain(page);
    }
    // And it must never run backwards while the reader only scrolls forward.
    expect(seen, "the page number must not go back up").toEqual([...seen].sort((a, b) => a - b));
  });
});

describe("visibleRange", () => {
  const layout = layoutPages(uniform(10), 10, 1, 10);

  it("covers the pages on screen plus one either side", () => {
    // Viewport spans pages 2 and 3.
    const r = visibleRange(layout, 900, 800, 1);
    expect(r.first).toBe(1);
    expect(r.last).toBe(4);
  });

  it("does not run past either end of the document", () => {
    expect(visibleRange(layout, 0, 600, 2).first).toBe(1);
    expect(visibleRange(layout, layout.total, 600, 2).last).toBe(10);
  });

  it("keeps a page mounted when scrolled beyond the column", () => {
    // Blanking the view is worse than rendering a page nobody can see.
    const r = visibleRange(layout, 99_999, 600, 0);
    expect(r.last).toBeGreaterThanOrEqual(r.first);
  });

  it("mounts nothing for a document with no pages", () => {
    const r = visibleRange(layoutPages([], 0, 1), 0, 600);
    expect(r.last).toBeLessThan(r.first);
  });
});

describe("offsetForPage", () => {
  const layout = layoutPages(uniform(5), 5, 1, PAGE_GAP);

  it("round-trips with pageAtScroll", () => {
    for (const page of [1, 2, 3, 4, 5]) {
      expect(pageAtScroll(layout, offsetForPage(layout, page), 800)).toBe(page);
    }
  });

  it("round-trips on pages that are not all the same height", () => {
    // The round-trip above was written for the invariant and then only ever
    // run on pages of one height — the one shape where it cannot fail. Real
    // documents have a short chapter divider, a landscape plate, a half page
    // at the end of a section, and there navigating to a page and reading the
    // page number back disagreed: the toolbar said 6 and the screen was
    // page 7.
    const sizes: PageSize[] = [
      { width: 600, height: 800 },
      { width: 600, height: 300 },
      { width: 600, height: 2000 },
      { width: 1000, height: 600 },
      { width: 600, height: 150 },
      { width: 600, height: 800 },
    ];
    const varied = layoutPages(sizes, sizes.length, 1, PAGE_GAP);
    for (let page = 1; page <= sizes.length; page += 1) {
      expect(
        pageAtScroll(varied, offsetForPage(varied, page), 860),
        `navigating to page ${page} must read back as page ${page}`,
      ).toBe(page);
    }
  });

  it("puts page 1 at the very top", () => {
    expect(offsetForPage(layout, 1)).toBe(0);
  });

  it("clamps a page number outside the document", () => {
    expect(offsetForPage(layout, 0)).toBe(0);
    expect(offsetForPage(layout, 99)).toBe(offsetForPage(layout, 5));
  });
});

describe("fitWidthScale", () => {
  it("fits the widest page, not the first", () => {
    // One landscape page mid-document must not reflow the column as the
    // reader passes it.
    const sizes = [A4, { width: 1000, height: 600 }, A4];
    expect(fitWidthScale(sizes, 1020, 10)).toBeCloseTo(1);
  });

  it("ignores pages that have not been measured", () => {
    expect(fitWidthScale([undefined, A4], 620, 10)).toBeCloseTo(1);
  });

  it("returns 1 when nothing is known", () => {
    expect(fitWidthScale([], 800, 10)).toBe(1);
  });
});

/**
 * Holding the reader's place while the column reflows under them.
 *
 * Pages are measured as the reader reaches them. Jump to page 50 and the forty
 * pages behind it are still standing in at page 1's height; scroll back up and
 * each is measured for the first time, moving everything below it — including
 * the paragraph being read. Measured in the browser on a sixty-page document
 * with mixed page heights before this existed: a 120px scroll up moved the text
 * by nothing at all, and a later one lost 488px, most of a screen.
 */
describe("scrollShiftForRelayout", () => {
  const short: PageSize = { width: 600, height: 400 };
  const tall: PageSize = { width: 600, height: 1200 };

  /** Ten pages standing in at page 1's height, as an unvisited stretch does. */
  const guessed = layoutPages([short], 10, 1, PAGE_GAP);

  it("moves the scroll by exactly what the page under the reader moved", () => {
    const sizes = [short, tall, tall, ...Array(7).fill(short)];
    const real = layoutPages(sizes, 10, 1, PAGE_GAP);
    // Reading page 5. Pages 2 and 3 turned out to be 800px taller than guessed.
    const scrollTop = offsetForPage(guessed, 5) + 100;
    const shift = scrollShiftForRelayout(guessed, real, scrollTop, 600);
    expect(shift).toBe(real.tops[4]! - guessed.tops[4]!);
    // Which is exactly what keeps page 5 — and the position within it — still.
    expect(pageAtScroll(real, scrollTop + shift, 600)).toBe(5);
    expect(scrollTop + shift - real.tops[4]!).toBe(scrollTop - guessed.tops[4]!);
  });

  it("does nothing when the column did not move", () => {
    const same = layoutPages([short], 10, 1, PAGE_GAP);
    expect(scrollShiftForRelayout(guessed, same, 900, 600)).toBe(0);
    expect(scrollShiftForRelayout(guessed, guessed, 900, 600)).toBe(0);
  });

  it("never scrolls above the top of the document", () => {
    // A page that turns out SHORTER than guessed shifts everything up; near the
    // top of the document that shift can exceed the scroll that exists.
    const real = layoutPages([tall, short, short], 3, 1, PAGE_GAP);
    const from = layoutPages([tall], 3, 1, PAGE_GAP);
    const shift = scrollShiftForRelayout(from, real, 50, 600);
    expect(50 + shift).toBeGreaterThanOrEqual(0);
  });

  it("holds its peace when the two layouts are not comparable", () => {
    // A different document, or one whose page count changed: there is no "same
    // place" to hold, and guessing one would throw the reader somewhere random.
    expect(scrollShiftForRelayout(guessed, layoutPages([short], 4, 1, PAGE_GAP), 900, 600)).toBe(0);
    expect(scrollShiftForRelayout(layoutPages([], 0, 1), layoutPages([], 0, 1), 0, 600)).toBe(0);
  });
});
