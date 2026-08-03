import { describe, expect, it } from "vitest";
import { clientRectToPageRect } from "./selection-quote";
import type { PageGeometry } from "../../lib/pdf";

const PAGE_W = 595;
const PAGE_H = 842;

/** An upright page: the viewport only flips y to reach PDF user space. */
const upright: PageGeometry = {
  viewportWidth: PAGE_W,
  toPdfPoint: (x, y) => [x, PAGE_H - y],
  view: [0, 0, PAGE_W, PAGE_H],
};

/**
 * A `/Rotate 90` page: it is painted turned, so the viewport is as wide as the
 * page is tall, and a point's screen axes are transposed relative to the page's.
 */
const rotated90: PageGeometry = {
  viewportWidth: PAGE_H,
  toPdfPoint: (x, y) => [y, x],
  view: [0, 0, PAGE_W, PAGE_H],
};

describe("clientRectToPageRect", () => {
  // A 595pt-wide page rendered 1190px wide: every point is two pixels.
  const pageBox = { left: 100, top: 50, width: 1190, height: 1684 };

  it("maps a selection into page points relative to the page box", () => {
    const rect = clientRectToPageRect(
      { left: 300, top: 250, width: 200, height: 100 },
      pageBox,
      upright,
    );
    expect(rect).toEqual({ x: 100, y: 100, width: 100, height: 50 });
  });

  it("puts a selection at the page's top-left corner at the origin", () => {
    const rect = clientRectToPageRect(
      { left: 100, top: 50, width: 10, height: 10 },
      pageBox,
      upright,
    );
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
  });

  it("is unaffected by zoom, since the page box scales with it", () => {
    const zoomed = { left: 0, top: 0, width: 2380, height: 3368 };
    const rect = clientRectToPageRect(
      { left: 400, top: 400, width: 400, height: 200 },
      zoomed,
      upright,
    );
    expect(rect).toEqual({ x: 100, y: 100, width: 100, height: 50 });
  });

  it("follows the page's rotation instead of the screen's axes", () => {
    // The rendered page is 842pt wide here, so 842px is 1:1.
    const box = { left: 0, top: 0, width: PAGE_H, height: PAGE_W };
    const rect = clientRectToPageRect(
      { left: 100, top: 200, width: 40, height: 30 },
      box,
      rotated90,
    );
    // Transposed: the selection's screen width becomes page height, and the
    // rect stays positive despite the corners swapping.
    expect(rect).toEqual({ x: 200, y: PAGE_H - 140, width: 30, height: 40 });
  });

  it("never produces a negative extent, whatever the rotation", () => {
    for (const geometry of [upright, rotated90]) {
      const rect = clientRectToPageRect(
        { left: 120, top: 90, width: 50, height: 70 },
        { left: 0, top: 0, width: geometry.viewportWidth, height: 500 },
        geometry,
      );
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
    }
  });

  it("does not divide by a collapsed page box", () => {
    const rect = clientRectToPageRect(
      { left: 0, top: 0, width: 10, height: 10 },
      { left: 0, top: 0, width: 0, height: 0 },
      upright,
    );
    expect(Number.isFinite(rect.x)).toBe(true);
    expect(Number.isFinite(rect.width)).toBe(true);
  });

  it("offsets by a page box whose origin is not zero", () => {
    const shifted: PageGeometry = {
      viewportWidth: PAGE_W,
      toPdfPoint: (x, y) => [x + 20, PAGE_H + 10 - y],
      view: [20, 10, PAGE_W + 20, PAGE_H + 10],
    };
    const rect = clientRectToPageRect(
      { left: 0, top: 0, width: 10, height: 10 },
      { left: 0, top: 0, width: PAGE_W, height: PAGE_H },
      shifted,
    );
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
  });
});
