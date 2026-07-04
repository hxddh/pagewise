import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export function useTauriFileDrop(onDrop: (paths: string[]) => void) {
  const [isDragging, setIsDragging] = useState(false);

  // Hold the callback in a ref so the effect can subscribe exactly once
  // ([] deps) instead of re-subscribing every time onDrop's identity changes.
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter") {
          setIsDragging(true);
        } else if (payload.type === "leave") {
          setIsDragging(false);
        } else if (payload.type === "drop") {
          setIsDragging(false);
          if (payload.paths.length > 0) {
            onDropRef.current(payload.paths);
          }
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

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return { isDragging };
}
