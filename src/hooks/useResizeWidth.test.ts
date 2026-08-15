import { describe, expect, it } from "vitest";
import { maxWidthFor } from "./useResizeWidth";

const MIN = 360;
const MAX = 480;
const ceiling = (viewport: number) => maxWidthFor(viewport, MAX, MIN);

/**
 * How wide the assistant panel may be, given the window it is in.
 *
 * The ceiling used to be a flat 480. At 900x600 — this app's own minWidth — a
 * 480px panel leaves the preview toolbar 199px for 302px of controls, and
 * "Mark a region" and "Zoom" are drawn 103px past its right edge, over the
 * assistant panel's own header; `elementFromPoint` at their centres returns
 * that header, so neither can be clicked.
 *
 * The width is persisted, so this is not only reachable by dragging: a reader
 * who sizes the panel on a large display and later opens a small window gets
 * 480 back. Verified with the screenshot harness at 900, 1000, 1100, 1200 and
 * 1440 — no toolbar overflow and nothing unreachable at any of them.
 */
describe("assistant panel width ceiling", () => {
  it("does not let the panel squeeze the toolbar off the window", () => {
    // At the smallest window the app allows there is no room to give at all,
    // so the panel is pinned to its minimum.
    expect(ceiling(900)).toBe(MIN);
    expect(ceiling(1000)).toBeLessThan(MAX);
  });

  it("still offers the full width once the window can afford it", () => {
    // The clamp has to bite only where it must — otherwise it is a regression
    // dressed as a fix, and a reader on a large display loses a panel size that
    // was never a problem.
    expect(ceiling(1100)).toBe(MAX);
    expect(ceiling(1440)).toBe(MAX);
    expect(ceiling(2560)).toBe(MAX);
  });

  it("never returns a ceiling below the floor", () => {
    // A window narrower than the app permits should still yield a usable
    // number rather than something below MIN, which would invert the clamp.
    for (const viewport of [0, 320, 640, 899]) {
      expect(ceiling(viewport), `viewport ${viewport}`).toBe(MIN);
    }
  });
});
