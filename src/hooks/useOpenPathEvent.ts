import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

/** What the Rust side emits when a second launch hands over its file. */
export const OPEN_PATH_EVENT = "pagewise://open-path";

/**
 * A document the reader opened from outside the app.
 *
 * Double-clicking a PDF, or `open -a PageWise paper.pdf`, starts a second copy
 * of the process. The single-instance plugin stops it: the second launch hands
 * its command line to the one already running and exits, and this is where that
 * path arrives. Without it a reader ends up with two windows, two conversations
 * and two ideas of which document is open.
 *
 * The callback is held in a ref so the subscription is made exactly once. A
 * dependency on the callback's identity would tear the listener down and build
 * it again on every render of whatever owns it — and a launch that lands in the
 * gap is a document that silently fails to open.
 */
export function useOpenPathEvent(onPath: (path: string) => void): void {
  const onPathRef = useRef(onPath);
  onPathRef.current = onPath;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<string>(OPEN_PATH_EVENT, (event) => {
      const path = typeof event.payload === "string" ? event.payload.trim() : "";
      if (path) onPathRef.current(path);
    })
      .then((fn) => {
        // Resolved after the owner unmounted: nothing is listening any more, so
        // release it rather than leaving a subscription pointing at a dead
        // callback.
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Not running under Tauri (tests, a browser harness). Opening from the
        // desktop is not a thing there either.
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
