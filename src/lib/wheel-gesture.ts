/** DOM_DELTA_* without relying on WheelEvent global (SSR/tests). */
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/** Normalize wheel delta to CSS pixels for consistent thresholds across devices. */
export function normalizeWheelDelta(
  e: WheelEvent,
  lineHeight = 16,
  elementHeight = 800,
): number {
  switch (e.deltaMode) {
    case DOM_DELTA_LINE:
      return e.deltaY * lineHeight;
    case DOM_DELTA_PAGE:
      return e.deltaY * elementHeight;
    default:
      return e.deltaY;
  }
}

export const WHEEL_GESTURE = {
  /** Fallback wait when swipe stops before threshold (partial gesture). */
  endMs: 80,
  /** Normalized px to flip in fit-width mode. */
  thresholdFit: 72,
  /** Normalized px to flip when zoomed at scroll edge. */
  thresholdEdge: 56,
  /** Min ms between wheel-driven flips. */
  minFlipGapMs: 240,
  /** Reset accumulation after this idle gap (ms). */
  accumIdleMs: 90,
} as const;

/** True when accumulated wheel delta is enough to flip immediately. */
export function wheelFlipReady(accum: number, threshold: number): boolean {
  return Math.abs(accum) >= threshold;
}
