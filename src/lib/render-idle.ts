/**
 * A one-way gate between what the reader is waiting for and everything else.
 *
 * Rendering a page for OCR or for the vision model is the same work as drawing
 * the page on screen — the same document, the same main thread, and at 200 DPI
 * a much bigger canvas. They used to run at the same time, which never blocked
 * the raster but did compete with it: a reader scrolling a scan while it was
 * being recognised felt the paint of pages they were not looking at.
 *
 * So the gate is one-directional, and that is the whole point: the raster never
 * waits on OCR; OCR waits for the raster. Work that the reader is waiting for
 * holds the gate while it is queued and while it runs; detached work (OCR,
 * vision) asks `whenIdle` first and goes when the gate opens. Nothing here can
 * starve the detached work — the display queue drains between frames — and
 * nothing here cancels it either, because an abandoned OCR paint would be
 * re-run from the start on the next attempt.
 */
export interface RenderIdleGate {
  /** The reader is waiting on something: hold the gate until released. */
  hold: () => void;
  /** That work finished, failed or was cancelled. */
  release: () => void;
  /** Resolves once nothing is held; immediately when nothing is. */
  whenIdle: () => Promise<void>;
}

export function createRenderIdleGate(): RenderIdleGate {
  let held = 0;
  let waiters: Array<() => void> = [];

  return {
    hold() {
      held += 1;
    },
    release() {
      if (held === 0) return;
      held -= 1;
      if (held > 0) return;
      const opening = waiters;
      waiters = [];
      for (const resolve of opening) resolve();
    },
    whenIdle() {
      if (held === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}
