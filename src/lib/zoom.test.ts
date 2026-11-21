import { describe, expect, it } from "vitest";
import { formatZoomLabel, isSameZoom, stepZoom } from "./zoom";

describe("zoom", () => {
  it("steps monotonically from the resolved scale when in fit-width or fit-page", () => {
    // At 1.55x resolved fit-width, zooming out steps to 1.5 (never dead) and
    // zooming in steps to 1.75 (never shrinking back to 1.0).
    expect(stepZoom("fit-width", -1, 1.55)).toBe(1.5);
    expect(stepZoom("fit-width", 1, 1.55)).toBe(1.75);
    expect(stepZoom("fit-page", 1, 0.82)).toBe(0.9);
    expect(stepZoom("comfortable", -1, 1.2)).toBe(1.1);
  });

  it("steps monotonically across numeric zoom levels and clamps at bounds", () => {
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(0.5, -1)).toBe(0.5);
    expect(stepZoom(3, 1)).toBe(3);
  });

  it("formats named and numeric zoom labels cleanly", () => {
    expect(formatZoomLabel("fit-width")).toBe("Fit");
    expect(formatZoomLabel("fit-page")).toBe("Page");
    expect(formatZoomLabel("comfortable")).toBe("Read");
    expect(formatZoomLabel(1.25)).toBe("125%");
    expect(isSameZoom(1.25, 1.2504)).toBe(true);
    expect(isSameZoom("fit-width", "fit-page")).toBe(false);
  });
});
