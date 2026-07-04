/** Normalize wheel delta to CSS pixels for consistent thresholds across devices. */
export function normalizeWheelDelta(
  e: WheelEvent,
  lineHeight = 16,
  elementHeight = 800,
): number {
  switch (e.deltaMode) {
    case WheelEvent.DOM_DELTA_LINE:
      return e.deltaY * lineHeight;
    case WheelEvent.DOM_DELTA_PAGE:
      return e.deltaY * elementHeight;
    default:
      return e.deltaY;
  }
}

export const WHEEL_GESTURE = {
  /** Wait for gesture pause before flipping. */
  endMs: 150,
  /** Normalized px to flip in fit-width mode. */
  thresholdFit: 95,
  /** Normalized px to flip when zoomed at scroll edge. */
  thresholdEdge: 70,
  /** Min ms between wheel-driven flips. */
  minFlipGapMs: 420,
  /** Reset accumulation after this idle gap (ms). */
  accumIdleMs: 120,
} as const;
