import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "pagewise.chatWidth";
const MIN = 360;
const MAX = 480;
const DEFAULT_WIDTH = 360;

function clampWidth(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function useResizeWidth(min = MIN, max = MAX) {
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const n = saved ? Number(saved) : DEFAULT_WIDTH;
    return Number.isFinite(n) ? clampWidth(n, min, max) : DEFAULT_WIDTH;
  });

  const dragging = useRef(false);
  // Mirror of the latest width so drag-end / cancel can persist it without
  // running localStorage.setItem inside a setState updater (impure; would
  // double-write under StrictMode).
  const widthRef = useRef(width);
  widthRef.current = width;

  const persistWidth = useCallback((w: number) => {
    localStorage.setItem(STORAGE_KEY, String(w));
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const next = clampWidth(window.innerWidth - e.clientX, min, max);
      widthRef.current = next;
      setWidth(next);
    };

    const endDrag = () => {
      if (!dragging.current) return;
      dragging.current = false;
      persistWidth(widthRef.current);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      // If we unmount mid-drag, persist the in-progress width and clear the flag
      // (pointer capture is released implicitly when the handle element unmounts).
      if (dragging.current) {
        dragging.current = false;
        persistWidth(widthRef.current);
      }
    };
  }, [min, max, persistWidth]);

  const nudgeWidth = useCallback(
    (deltaPx: number) => {
      const next = clampWidth(widthRef.current + deltaPx, min, max);
      widthRef.current = next;
      setWidth(next);
      persistWidth(next);
    },
    [min, max, persistWidth],
  );

  return { width, onPointerDown, nudgeWidth, min, max };
}
