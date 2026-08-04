import { describe, expect, it } from "vitest";
import {
  fitWidthScale,
  layoutPages,
  offsetForPage,
  pageAtScroll,
  PAGE_GAP,
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
