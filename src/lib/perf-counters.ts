/**
 * Counts for the perf probe (22.0): how many times the app did something,
 * where timing alone cannot say whether it was needed — a page rasterized
 * again after a fast scroll ends, a page's geometry asked for by each layer.
 *
 * The app never reads them. They live on `globalThis` so the probe can read
 * them from the built bundle, and an increment is all they cost.
 */
type Counters = Record<string, number>;

const counters: Counters = ((globalThis as { __pagewiseCounters?: Counters }).__pagewiseCounters ??= {});

export function countEvent(name: "raster" | "geometry"): void {
  counters[name] = (counters[name] ?? 0) + 1;
}
