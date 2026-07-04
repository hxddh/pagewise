import { describe, expect, it } from "vitest";
import {
  normalizeWheelDelta,
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
    expect(wheelFlipReady(71, WHEEL_GESTURE.thresholdFit)).toBe(false);
    expect(wheelFlipReady(72, WHEEL_GESTURE.thresholdFit)).toBe(true);
    expect(wheelFlipReady(-80, WHEEL_GESTURE.thresholdFit)).toBe(true);
  });
});
