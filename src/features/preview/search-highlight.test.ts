import { describe, expect, it } from "vitest";
import { highlightBoxes, matchingItems, pdfRectToBox, topLeftRectToBox } from "./search-highlight";
import type { PageGeometry } from "../../lib/pdf";
import type { TextItemRect } from "../../lib/types";

const PAGE_W = 600;
const PAGE_H = 800;

/** Upright page: the viewport transform only flips y. */
const upright: PageGeometry = {
  viewportWidth: PAGE_W,
  viewportHeight: PAGE_H,
  toPdfPoint: (x, y) => [x, PAGE_H - y],
  toViewportPoint: (x, y) => [x, PAGE_H - y],
  view: [0, 0, PAGE_W, PAGE_H],
};

/** `/Rotate 90`: the page is painted turned, so the axes are transposed. */
const rotated90: PageGeometry = {
  viewportWidth: PAGE_H,
  viewportHeight: PAGE_W,
  toPdfPoint: (x, y) => [y, x],
  toViewportPoint: (x, y) => [y, x],
  view: [0, 0, PAGE_W, PAGE_H],
};

const items: TextItemRect[] = [
  { text: "营业收入", rect: { x: 42, y: 654, width: 48, height: 12 } },
  { text: "1,284", rect: { x: 106, y: 654, width: 32, height: 12 } },
  { text: "Revenue rose", rect: { x: 42, y: 600, width: 90, height: 12 } },
];

describe("matchingItems", () => {
  it("finds the run a phrase sits in", () => {
    expect(matchingItems(items, "1,284").map((i) => i.text)).toEqual(["1,284"]);
  });

  it("ignores case and surrounding whitespace in the query", () => {
    expect(matchingItems(items, "  REVENUE  ").map((i) => i.text)).toEqual([
      "Revenue rose",
    ]);
  });

  it("returns nothing for an empty query rather than every run", () => {
    expect(matchingItems(items, "")).toEqual([]);
    expect(matchingItems(items, "   ")).toEqual([]);
  });

  it("returns nothing when the phrase is split across runs", () => {
    // "收入 1,284" spans two runs; no highlight beats a wrong one.
    expect(matchingItems(items, "营业收入 1,284")).toEqual([]);
  });

  it("caps how many boxes one query can produce", () => {
    const many: TextItemRect[] = Array.from({ length: 200 }, () => items[0]!);
    expect(matchingItems(many, "营业").length).toBeLessThanOrEqual(60);
  });
});

describe("pdfRectToBox", () => {
  it("places a rect as fractions measured from the page's top-left", () => {
    // PDF y=654..666 is 134..146 from the top of an 800pt page.
    const box = pdfRectToBox({ x: 60, y: 654, width: 60, height: 12 }, upright);
    expect(box.left).toBeCloseTo(0.1);
    expect(box.top).toBeCloseTo(134 / PAGE_H);
    expect(box.width).toBeCloseTo(0.1);
    expect(box.height).toBeCloseTo(12 / PAGE_H);
  });

  it("follows the page's rotation instead of assuming upright axes", () => {
    const box = pdfRectToBox({ x: 100, y: 200, width: 40, height: 20 }, rotated90);
    // Transposed: the rect's PDF width becomes vertical extent on screen.
    expect(box.left).toBeCloseTo(200 / PAGE_H);
    expect(box.top).toBeCloseTo(100 / PAGE_W);
    expect(box.width).toBeCloseTo(20 / PAGE_H);
    expect(box.height).toBeCloseTo(40 / PAGE_W);
  });

  it("never produces a negative extent, whatever the rotation", () => {
    for (const geometry of [upright, rotated90]) {
      const box = pdfRectToBox({ x: 10, y: 10, width: 30, height: 40 }, geometry);
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
    }
  });

  it("keeps a mark written off the page on the page", () => {
    // What a pre-6.2 region drag past the page's edge left in the file: a rect
    // starting left of the page and running past its bottom. Unclamped it drew
    // over the neighbouring page.
    const box = pdfRectToBox({ x: -200, y: -300, width: 400, height: 1400 }, upright);
    expect(box.left).toBe(0);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.left + box.width).toBeLessThanOrEqual(1);
    expect(box.top + box.height).toBeLessThanOrEqual(1);
  });

  it("draws nothing for a rect that misses the page entirely", () => {
    const box = pdfRectToBox({ x: 5000, y: 5000, width: 100, height: 100 }, upright);
    expect(box.width).toBe(0);
    expect(box.height).toBe(0);
  });

  it("does not divide by a degenerate page", () => {
    const degenerate: PageGeometry = { ...upright, viewportWidth: 0, viewportHeight: 0 };
    const box = pdfRectToBox({ x: 1, y: 1, width: 1, height: 1 }, degenerate);
    expect(Number.isFinite(box.left)).toBe(true);
    expect(Number.isFinite(box.width)).toBe(true);
  });
});

describe("highlightBoxes", () => {
  it("returns one box per matching run", () => {
    expect(highlightBoxes(items, "营业收入", upright)).toHaveLength(1);
    expect(highlightBoxes(items, "nothing here", upright)).toHaveLength(0);
  });
});

/**
 * The reader's marks are measured from the other edge.
 *
 * `clientRectToPageRect` returns a top-left origin because that is what
 * `extract_region` takes; `page_text_items` and link rectangles come from Rust
 * measured from the bottom. Marks went through the bottom-left conversion, and
 * every one a reader made was drawn mirrored about the middle of the page.
 *
 * Measured in a browser on a real PDF before this was written down: a box
 * dragged across 5%–15% down the page appeared at 85%, and one dragged at
 * 80%–92% appeared at 8%. Width, height and horizontal position were exactly
 * right in every case, which is why it read as a rendering quirk rather than a
 * wrong coordinate system.
 */
describe("topLeftRectToBox", () => {
  it("keeps a rect near the top of the page near the top", () => {
    // 40pt down from an 800pt page's top edge is 5% down. Under the bottom-left
    // conversion this same rect came out at 92.5%.
    const box = topLeftRectToBox({ x: 60, y: 40, width: 120, height: 20 }, upright);
    expect(box.top).toBeCloseTo(0.05, 5);
    expect(box.height).toBeCloseTo(0.025, 5);
    expect(box.left).toBeCloseTo(0.1, 5);
    expect(box.width).toBeCloseTo(0.2, 5);
  });

  it("keeps a rect near the bottom of the page near the bottom", () => {
    const box = topLeftRectToBox({ x: 60, y: 720, width: 120, height: 40 }, upright);
    expect(box.top).toBeCloseTo(0.9, 5);
    expect(box.height).toBeCloseTo(0.05, 5);
  });

  it("is not the bottom-left conversion", () => {
    // The two agree only on a rect centred on the page — which is exactly the
    // shape a first test would use, and why this survived.
    const offCentre = { x: 60, y: 40, width: 120, height: 20 };
    expect(topLeftRectToBox(offCentre, upright).top).not.toBeCloseTo(
      pdfRectToBox(offCentre, upright).top,
      3,
    );

    const centred = { x: 60, y: 390, width: 120, height: 20 };
    expect(topLeftRectToBox(centred, upright).top).toBeCloseTo(
      pdfRectToBox(centred, upright).top,
      5,
    );
  });

  it("round-trips a rect back to where the reader drew it", () => {
    // The whole contract: a fraction of the page down, converted to storage and
    // back, must be the same fraction down.
    for (const y of [0, 100, 400, 700, 780]) {
      const box = topLeftRectToBox({ x: 0, y, width: 100, height: 20 }, upright);
      expect(box.top, `a mark ${y}pt from the top must draw ${y}pt from the top`).toBeCloseTo(
        y / PAGE_H,
        5,
      );
    }
  });

  it("survives a page that is painted rotated", () => {
    // Both corners go through the viewport transform, so a /Rotate 90 page
    // transposes rather than mirrors. Nothing may fall off the page.
    const box = topLeftRectToBox({ x: 60, y: 40, width: 120, height: 20 }, rotated90);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.left + box.width).toBeLessThanOrEqual(1);
    expect(box.top + box.height).toBeLessThanOrEqual(1);
  });
});
