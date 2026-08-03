import { describe, expect, it } from "vitest";
import { clientRectToPageRect } from "./selection-quote";

describe("clientRectToPageRect", () => {
  // A 595pt-wide page rendered 1190px wide: every point is two pixels.
  const pageBox = { left: 100, top: 50, width: 1190, height: 1684 };

  it("maps a selection into page points relative to the page box", () => {
    const rect = clientRectToPageRect(
      { left: 300, top: 250, width: 200, height: 100 },
      pageBox,
      595,
    );
    expect(rect).toEqual({ x: 100, y: 100, width: 100, height: 50 });
  });

  it("puts a selection at the page's top-left corner at the origin", () => {
    const rect = clientRectToPageRect(
      { left: 100, top: 50, width: 10, height: 10 },
      pageBox,
      595,
    );
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
  });

  it("is unaffected by zoom, since the page box scales with it", () => {
    const zoomed = { left: 0, top: 0, width: 2380, height: 3368 };
    const rect = clientRectToPageRect(
      { left: 400, top: 400, width: 400, height: 200 },
      zoomed,
      595,
    );
    expect(rect).toEqual({ x: 100, y: 100, width: 100, height: 50 });
  });

  it("does not divide by a collapsed page box", () => {
    const rect = clientRectToPageRect(
      { left: 0, top: 0, width: 10, height: 10 },
      { left: 0, top: 0, width: 0, height: 0 },
      595,
    );
    expect(Number.isFinite(rect.x)).toBe(true);
    expect(Number.isFinite(rect.width)).toBe(true);
  });
});
