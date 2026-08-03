import { describe, expect, it } from "vitest";
import { highlightBoxes, matchingItems, pdfRectToBox } from "./search-highlight";
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
