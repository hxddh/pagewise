import { describe, expect, it } from "vitest";
import { lineRects } from "./useAskSelection";

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height } as DOMRect;
}

function range(rects: DOMRect[]) {
  return { getClientRects: () => rects as unknown as DOMRectList };
}

const FALLBACK = { left: 0, top: 0, width: 300, height: 40 };

describe("lineRects", () => {
  it("keeps one box per line rather than one slab over the paragraph", () => {
    // The bounding box of these three lines would also cover the first line's
    // left margin and the last line's right margin.
    const rects = lineRects(
      range([rect(120, 10, 180, 12), rect(20, 24, 280, 12), rect(20, 38, 60, 12)]),
      FALLBACK,
    );
    expect(rects).toHaveLength(3);
    expect(rects[0]).toEqual({ left: 120, top: 10, width: 180, height: 12 });
  });

  it("drops the sub-pixel rects a browser reports between lines", () => {
    const rects = lineRects(range([rect(20, 10, 200, 12), rect(220, 10, 0, 12)]), FALLBACK);
    expect(rects).toHaveLength(1);
  });

  it("falls back to the bounding box when there are no line rects", () => {
    expect(lineRects(range([]), FALLBACK)).toEqual([FALLBACK]);
  });

  it("caps a runaway selection", () => {
    const many = Array.from({ length: 500 }, (_, i) => rect(20, i * 12, 200, 12));
    expect(lineRects(range(many), FALLBACK)).toHaveLength(200);
  });
});
