import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invokeCmd } from "../lib/invoke-cmd";

export const OPEN_PATH_EVENT = "pagewise://open-path";
export const OPEN_PENDING_EVENT = "pagewise://open-pending";
export const OPEN_REFUSED_EVENT = "pagewise://open-refused";

export function useOpenPathEvent(
  onPath: (path: string) => void,
  onRefused?: (reason: string) => void,
): void {
  const onPathRef = useRef(onPath);
  onPathRef.current = onPath;
  const onRefusedRef = useRef(onRefused);
  onRefusedRef.current = onRefused;

  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    const deliver = (raw: unknown) => {
      const path = typeof raw === "string" ? raw.trim() : "";
      if (path && !disposed) onPathRef.current(path);
    };
    const deliverError = (raw: unknown) => {
      const err = typeof raw === "string" ? raw.trim() : "";
      if (err && !disposed) onRefusedRef.current?.(err);
    };
    const takePending = () => {
      void invokeCmd<string | null>("take_pending_open").then(deliver, () => {});
      void invokeCmd<string | null>("take_pending_open_error").then(deliverError, () => {});
    };

    const subscriptions = [
      listen<string>(OPEN_PATH_EVENT, (event) => deliver(event.payload)),
      listen<string>(OPEN_REFUSED_EVENT, (event) => {
        void invokeCmd<string | null>("take_pending_open_error").catch(() => {});
        deliverError(event.payload);
      }),
      listen(OPEN_PENDING_EVENT, () => takePending()),
    ];
    for (const sub of subscriptions) {
      sub.then(
        (fn) => {
          if (disposed) fn();
          else unlisten.push(fn);
        },
        () => {},
      );
    }
    void Promise.allSettled(subscriptions).then(() => {
      if (!disposed) takePending();
    });

    return () => {
      disposed = true;
      for (const fn of unlisten) fn();
    };
  }, []);
}
