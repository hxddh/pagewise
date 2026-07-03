import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export function useTauriFileDrop(onDrop: (paths: string[]) => void) {
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
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
            onDrop(payload.paths);
          }
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        // Not running inside Tauri (e.g. vite-only dev in browser)
      });

    return () => {
      unlisten?.();
    };
  }, [onDrop]);

  return { isDragging };
}
