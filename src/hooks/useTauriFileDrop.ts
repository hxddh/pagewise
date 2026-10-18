import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/**
 * The documents of a drop, after Rust has granted them (21.0). The webview's
 * own drop event still drives the "dragging" state, but its paths are not
 * opened: they are not granted, and nothing in the webview can grant them.
 */
export const DROPPED_EVENT = "pagewise://dropped";
/**
 * The file names of a drop Rust granted nothing from — a DOCX, a HEIC photo
 * (24.0). Before, such a drop did nothing at all.
 */
export const DROP_REFUSED_EVENT = "pagewise://drop-refused";

export function useTauriFileDrop(
  onDrop: (paths: string[]) => void,
  onRefused?: (names: string[]) => void,
) {
  const [isDragging, setIsDragging] = useState(false);

  // Hold the callback in a ref so the effect can subscribe exactly once
  // ([] deps) instead of re-subscribing every time onDrop's identity changes.
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const onRefusedRef = useRef(onRefused);
  onRefusedRef.current = onRefused;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let unlistenDropped: (() => void) | undefined;
    let unlistenRefused: (() => void) | undefined;

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

    listen<string[]>(DROP_REFUSED_EVENT, (event) => {
      if (event.payload.length > 0) onRefusedRef.current?.(event.payload);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlistenRefused = fn;
      })
      .catch(() => {
        // Not running inside Tauri.
      });

    return () => {
      disposed = true;
      unlisten?.();
      unlistenDropped?.();
      unlistenRefused?.();
    };
  }, []);

  return { isDragging };
}
