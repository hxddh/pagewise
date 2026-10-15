import { describe, expect, it } from "vitest";
import { buildScaleKey } from "./pdf";

/**
 * The fit-width cache key (20.0).
 *
 * The key names the bitmap's size: the container it was fitted into, the
 * margin reserved, and the scale that came out. Until 20.0 it named only the
 * container width, so any change that moved the scale without moving the
 * width — a landscape page measured mid-document, or the margin column
 * opening — reused a bitmap rendered at another scale, and the page slot's
 * `overflow: hidden` cut off the part that no longer fitted.
 */
describe("buildScaleKey", () => {
  it("names the resolved scale, not only the container width", () => {
    // Same container, different scale: a landscape page was measured.
    const before = buildScaleKey("fit-width", 1000, 1.5, 240);
    const after = buildScaleKey("fit-width", 1000, 0.92, 240);
    expect(after).not.toBe(before);
  });

  it("names the reserved margin", () => {
    // The column opening changes the reserve; the scale changes with it, and
    // the reserve is in the key on its own account too.
    const dots = buildScaleKey("fit-width", 1000, 1.5, 24);
    const column = buildScaleKey("fit-width", 1000, 1.5, 240);
    expect(column).not.toBe(dots);
  });

  it("is the same key for the same inputs", () => {
    expect(buildScaleKey("fit-width", 1000, 1.5, 240)).toBe(
      buildScaleKey("fit-width", 1000, 1.5, 240),
    );
  });

  it("does not re-render on every pixel of a resize", () => {
    // The quanta exist so a window drag does not re-render each mounted page
    // per frame: within one 32px width step and one 32‰ scale step the key
    // holds, which is the tolerance the old width-only key had.
    const a = buildScaleKey("fit-width", 1000, 1.5, 240);
    const b = buildScaleKey("fit-width", 1005, 1.505, 240);
    expect(b).toBe(a);
    // Crossing either quantum misses.
    expect(buildScaleKey("fit-width", 1040, 1.5, 240)).not.toBe(a);
    expect(buildScaleKey("fit-width", 1000, 1.55, 240)).not.toBe(a);
  });

  it("keeps a fixed zoom keyed on its scale alone", () => {
    // At a fixed zoom the reserve does not enter the arithmetic, so it must
    // not invalidate a bitmap the scale already describes.
    expect(buildScaleKey(1.25, 1000, 1.25, 240)).toBe(buildScaleKey(1.25, 1000, 1.25, 24));
    expect(buildScaleKey(1.25, 1000, 1.25, 24)).not.toBe(buildScaleKey(1.5, 1000, 1.5, 24));
  });
});
