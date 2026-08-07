import { describe, expect, it } from "vitest";
import { MAX_CROP_PAGE_EDGE, regionRenderScale } from "./pdf";

/**
 * The same defect `visionRenderScale` was extracted to fix (N1, 3.4.0), in the
 * function written after it.
 *
 * `paintPage` multiplies whatever scale it is handed by `getOutputScale()`, so a
 * caller that wants a specific pixel count must divide that multiplier back out.
 * `renderPageToJpegBytes` does. `renderRegionToJpegBytes` — added later, for
 * `read_figure` — did not, so on a retina display both of its promises were off
 * by the device pixel ratio: the crop came out at twice its intended long edge,
 * and the page it is cut from was painted at twice the 4096px ceiling that
 * exists to stop a small figure demanding an enormous render.
 *
 * The ceiling is the one that binds most of the time. 4096/792 is a 5.17x page
 * paint, so on a letter page any figure under ~303pt on its long edge — most
 * figures — is limited by the ceiling and never reaches `maxEdge` at all. Both
 * quantities are asserted here; both are DPR-independent promises.
 */

/** What the crop actually ends up being, in pixels. */
const cropEdge = (regionEdge: number, pageEdge: number, maxEdge: number, outputScale: number) =>
  regionEdge * regionRenderScale(regionEdge, pageEdge, maxEdge, outputScale) * outputScale;

/** What the page beneath it is painted at, in pixels. */
const paintedPageEdge = (
  regionEdge: number,
  pageEdge: number,
  maxEdge: number,
  outputScale: number,
) => pageEdge * regionRenderScale(regionEdge, pageEdge, maxEdge, outputScale) * outputScale;

const PAGE = 792; // letter, long edge in points
const BIG_FIGURE = 400; // large enough that maxEdge binds, not the page ceiling
const SMALL_FIGURE = 24; // the smallest `figuresOnPage` will offer
const DPRS = [1, 1.5, 2];

describe("regionRenderScale", () => {
  it("encodes a large figure at maxEdge", () => {
    expect(cropEdge(BIG_FIGURE, PAGE, 1568, 1)).toBeCloseTo(1568, 3);
  });

  it("encodes the same crop on retina, not a doubled one", () => {
    // Before the fix this was ~3136px: four times the pixels, four times the
    // JPEG, for an image the vision provider downscales to maxEdge on arrival.
    expect(cropEdge(BIG_FIGURE, PAGE, 1568, 2)).toBeCloseTo(1568, 3);
    expect(cropEdge(BIG_FIGURE, PAGE, 1568, 2)).toBeCloseTo(
      cropEdge(BIG_FIGURE, PAGE, 1568, 1),
      3,
    );
  });

  it("never exceeds maxEdge at any device pixel ratio", () => {
    for (const dpr of DPRS) {
      expect(cropEdge(BIG_FIGURE, PAGE, 1568, dpr)).toBeLessThanOrEqual(1568 + 1e-6);
    }
  });

  it("holds the page paint under its ceiling at any device pixel ratio", () => {
    // A 24pt logo wants a 65x page render to reach 1568px. MAX_CROP_PAGE_EDGE
    // is what says no. Unfixed, retina painted 8192px on the long edge: an
    // ~87-megapixel canvas, ~350MB of backing store, to cut a thumbnail out of.
    for (const dpr of DPRS) {
      expect(paintedPageEdge(SMALL_FIGURE, PAGE, 1568, dpr)).toBeLessThanOrEqual(
        MAX_CROP_PAGE_EDGE + 1e-6,
      );
    }
    expect(paintedPageEdge(SMALL_FIGURE, PAGE, 1568, 1)).toBeCloseTo(MAX_CROP_PAGE_EDGE, 3);
  });

  it("gives a ceiling-limited figure the same crop at every device pixel ratio", () => {
    // The ordinary case: a third-of-a-page figure, capped by the page ceiling
    // rather than by maxEdge. It still must not depend on the display.
    const at1 = cropEdge(264, PAGE, 1568, 1);
    for (const dpr of DPRS) {
      expect(cropEdge(264, PAGE, 1568, dpr)).toBeCloseTo(at1, 3);
    }
    expect(at1).toBeLessThan(1568);
  });

  it("falls back to the undivided scale when outputScale is non-positive", () => {
    // jsdom, and any environment reporting no devicePixelRatio. Mirrors
    // visionRenderScale so the two cannot drift apart again.
    expect(regionRenderScale(BIG_FIGURE, PAGE, 1568, 0)).toBeCloseTo(
      regionRenderScale(BIG_FIGURE, PAGE, 1568, 1),
      6,
    );
  });

  it("does not divide by a zero page edge", () => {
    expect(Number.isFinite(regionRenderScale(BIG_FIGURE, 0, 1568, 2))).toBe(true);
  });
});
