/**
 * Report a value only once it has stopped changing.
 *
 * The preview sends the page you are looking at for vision indexing when it has
 * no text of its own. While pages turned one at a time that was bounded by how
 * fast someone can click. Once the document scrolls, the current page changes
 * continuously, and scrolling through a scanned document would spend one billed
 * vision call per page passed — the pages you scrolled *past*, not the one you
 * stopped on.
 *
 * "Looking at a page" means having stopped on it, so that is what this encodes.
 */
export interface Settler<T> {
  /** Note the value now. The callback fires only if it stays put. */
  push(value: T): void;
  /** Drop any pending callback. */
  cancel(): void;
}

export function createSettler<T>(
  delayMs: number,
  onSettled: (value: T) => void,
  schedule: (fn: () => void, ms: number) => number = (fn, ms) =>
    setTimeout(fn, ms) as unknown as number,
  clear: (handle: number) => void = (h) => clearTimeout(h),
): Settler<T> {
  let timer: number | undefined;
  let pending: { value: T } | null = null;
  let settled: { value: T } | null = null;

  return {
    push(value: T) {
      // Already reported and unchanged — nothing to wait for, and re-reporting
      // would send the same page again.
      if (settled && Object.is(settled.value, value)) {
        pending = null;
        if (timer !== undefined) {
          clear(timer);
          timer = undefined;
        }
        return;
      }
      if (pending && Object.is(pending.value, value)) return;
      pending = { value };
      if (timer !== undefined) clear(timer);
      timer = schedule(() => {
        timer = undefined;
        if (!pending) return;
        settled = pending;
        pending = null;
        onSettled(settled.value);
      }, delayMs);
    },
    cancel() {
      pending = null;
      if (timer !== undefined) {
        clear(timer);
        timer = undefined;
      }
    },
  };
}
