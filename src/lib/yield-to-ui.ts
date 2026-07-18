/**
 * Yield so Tauri/WebKit can paint streaming UI updates between agent tool steps.
 *
 * A hidden/occluded/minimized WKWebView (and minimized WebView2) PAUSES
 * requestAnimationFrame, so a naive rAF-based yield would never resolve and the
 * agent run would wedge before its next tool call with no way to recover but a
 * window restore. Guard against that two ways: skip rAF entirely when the
 * document is hidden, and always race a setTimeout fallback so a paused/never-
 * firing rAF can't hang the promise.
 */
export function yieldToUi(): Promise<void> {
  // No document (non-DOM/test context) or hidden window: a macrotask is enough
  // and rAF may never fire.
  if (typeof document === "undefined" || document.hidden) {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // Fallback: if rAF is throttled/paused (window occluded mid-run), this still
    // resolves so the run keeps making progress.
    const fallback = setTimeout(done, 50);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        clearTimeout(fallback);
        setTimeout(done, 0);
      });
    });
  });
}
