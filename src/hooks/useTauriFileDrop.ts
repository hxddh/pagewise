import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/**
 * The documents of a drop, after Rust has granted them (21.0). The webview's
 * own drop event still drives the "dragging" state, but its paths are not
 * opened: they are not granted, and nothing in the webview can grant them.
 */
export const DROPPED_EVENT = "pagewise://dropped";

export function useTauriFileDrop(onDrop: (paths: string[]) => void) {
  const [isDragging, setIsDragging] = useState(false);

  // Hold the callback in a ref so the effect can subscribe exactly once
  // ([] deps) instead of re-subscribing every time onDrop's identity changes.
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let unlistenDropped: (() => void) | undefined;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter") {
          setIsDragging(true);
        } else if (payload.type === "leave") {
          setIsDragging(false);
        } else if (payload.type === "drop") {
          setIsDragging(false);
        }
      })
      .then((fn) => {
        // If cleanup already ran before the listener resolved, unlisten now —
        // otherwise the listener would leak forever.
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Not running inside Tauri (e.g. vite-only dev in browser)
      });

    listen<string[]>(DROPPED_EVENT, (event) => {
      if (event.payload.length > 0) onDropRef.current(event.payload);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlistenDropped = fn;
      })
      .catch(() => {
        // Not running inside Tauri.
      });

    return () => {
      disposed = true;
      unlisten?.();
      unlistenDropped?.();
    };
  }, []);

  return { isDragging };
}
