import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "pagewise.chatWidth";

export function useResizeWidth(defaultWidth = 380, min = 300, max = 560) {
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const n = saved ? Number(saved) : defaultWidth;
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : defaultWidth;
  });

  const dragging = useRef(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragging.current = true;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const next = Math.min(max, Math.max(min, window.innerWidth - e.clientX));
      setWidth(next);
    };

    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      setWidth((w) => {
        localStorage.setItem(STORAGE_KEY, String(w));
        return w;
      });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [min, max]);

  return { width, onPointerDown };
}
