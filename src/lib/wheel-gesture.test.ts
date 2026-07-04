import { describe, expect, it } from "vitest";
import {
  isPageVerticallyScrollable,
  normalizeWheelDelta,
  shouldScrollWithinPage,
  WHEEL_GESTURE,
  wheelFlipReady,
} from "./wheel-gesture";

describe("normalizeWheelDelta", () => {
  it("returns deltaY in pixel mode", () => {
    const e = { deltaY: 12, deltaMode: 0 } as WheelEvent;
    expect(normalizeWheelDelta(e)).toBe(12);
  });

  it("converts line mode to pixels", () => {
    const e = { deltaY: 3, deltaMode: 1 } as WheelEvent;
    expect(normalizeWheelDelta(e, 16)).toBe(48);
  });
});

describe("wheelFlipReady", () => {
  it("flips when accumulation crosses threshold", () => {
    expect(wheelFlipReady(87, WHEEL_GESTURE.thresholdFit)).toBe(false);
    expect(wheelFlipReady(88, WHEEL_GESTURE.thresholdFit)).toBe(true);
    expect(wheelFlipReady(-90, WHEEL_GESTURE.thresholdFit)).toBe(true);
  });
});

describe("shouldScrollWithinPage", () => {
  it("allows in-page scroll when content is taller than viewport", () => {
    expect(shouldScrollWithinPage(10, false, false, true)).toBe(true);
    expect(shouldScrollWithinPage(-10, false, false, true)).toBe(true);
    expect(shouldScrollWithinPage(10, false, true, true)).toBe(false);
    expect(shouldScrollWithinPage(-10, true, false, true)).toBe(false);
  });

  it("does not defer when page fits on screen", () => {
    expect(shouldScrollWithinPage(10, true, true, false)).toBe(false);
  });
});

describe("isPageVerticallyScrollable", () => {
  it("detects overflow with slack", () => {
    expect(isPageVerticallyScrollable(900, 800)).toBe(true);
    expect(isPageVerticallyScrollable(801, 800)).toBe(false);
  });
});
