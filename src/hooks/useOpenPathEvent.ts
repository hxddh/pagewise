import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invokeCmd } from "../lib/invoke-cmd";

/** What the Rust side emits when a second launch hands over its file. */
export const OPEN_PATH_EVENT = "pagewise://open-path";
/** A file is waiting to be taken: macOS's open event (16.0). */
export const OPEN_PENDING_EVENT = "pagewise://open-pending";

/**
 * A document the reader opened from outside the app.
 *
 * Double-clicking a PDF, or `open -a PageWise paper.pdf`, starts a second copy
 * of the process. The single-instance plugin stops it: the second launch hands
 * its command line to the one already running and exits, and this is where that
 * path arrives. Without it a reader ends up with two windows, two conversations
 * and two ideas of which document is open.
 *
 * And the file this launch itself was started with (16.0): Rust keeps it
 * until asked, and it is asked for once the listener is in place — before,
 * a PDF double-clicked while the app was closed opened nothing.
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
    const unlisten: Array<() => void> = [];
    const deliver = (raw: unknown) => {
      const path = typeof raw === "string" ? raw.trim() : "";
      if (path && !disposed) onPathRef.current(path);
    };
    const takePending = () =>
      invokeCmd<string | null>("take_pending_open").then(deliver, () => {
        // Not running under Tauri, or an older backend without the command.
      });

    const subscriptions = [
      listen<string>(OPEN_PATH_EVENT, (event) => deliver(event.payload)),
      listen(OPEN_PENDING_EVENT, () => void takePending()),
    ];
    for (const sub of subscriptions) {
      sub.then(
        (fn) => {
          // Resolved after the owner unmounted: nothing is listening any
          // more, so release it rather than leaving a subscription pointing
          // at a dead callback.
          if (disposed) fn();
          else unlisten.push(fn);
        },
        () => {
          // Not running under Tauri (tests, a browser harness). Opening from
          // the desktop is not a thing there either.
        },
      );
    }
    // Listening first, then asking: a file that arrives in between is either
    // still pending or announced to a listener that is already there.
    void Promise.allSettled(subscriptions).then(() => {
      if (!disposed) void takePending();
    });

    return () => {
      disposed = true;
      for (const fn of unlisten) fn();
    };
  }, []);
}
