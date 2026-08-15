import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "pagewise.chatWidth";
const MIN = 360;
const MAX = 480;
const DEFAULT_WIDTH = 360;

/**
 * What the document side needs before its toolbar starts running off the end:
 * the app rail, the page sidebar, and the toolbar's own controls.
 *
 * Without it the ceiling was a flat 480 whatever the window was. At 900x600 —
 * this app's own minWidth — a 480px chat leaves the preview toolbar 199px for
 * 302px of controls, and "Mark a region" and "Zoom" are drawn 103px past its
 * right edge, on top of the assistant panel's header. `elementFromPoint` at
 * their centres returns that header: both are unreachable.
 *
 * The width is persisted, so this is not only a drag away — a reader who sizes
 * the panel on a large display and later opens a small window gets 480 back.
 * That restore is the path this clamp mostly exists for.
 */
const PREVIEW_FLOOR = 560;

/** The widest the chat may be in this window, never below the floor of MIN. */
export function maxWidthFor(viewport: number, max: number, min: number): number {
  return Math.max(min, Math.min(max, viewport - PREVIEW_FLOOR));
}

function clampWidth(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function useResizeWidth(min = MIN, max = MAX) {
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const n = saved ? Number(saved) : DEFAULT_WIDTH;
    const ceiling = maxWidthFor(window.innerWidth, max, min);
    return Number.isFinite(n) ? clampWidth(n, min, ceiling) : DEFAULT_WIDTH;
  });

  // Reported to the resize handle, which passes it to `aria-valuemax`. It has to
  // be the ceiling actually in force, or the control tells a screen reader it
  // goes to 480 in a window where it stops at 360.
  const [ceiling, setCeiling] = useState(() => maxWidthFor(window.innerWidth, max, min));

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
      const ceiling = maxWidthFor(window.innerWidth, max, min);
      const next = clampWidth(window.innerWidth - e.clientX, min, ceiling);
      widthRef.current = next;
      setWidth(next);
    };

    // A window narrowed after the fact reaches the same broken layout as a drag
    // would, so the ceiling is re-applied rather than only enforced on input.
    const onResize = () => {
      const next = maxWidthFor(window.innerWidth, max, min);
      setCeiling(next);
      if (widthRef.current <= next) return;
      widthRef.current = next;
      setWidth(next);
      persistWidth(next);
    };

    const endDrag = () => {
      if (!dragging.current) return;
      dragging.current = false;
      persistWidth(widthRef.current);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("resize", onResize);
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
      const next = clampWidth(widthRef.current + deltaPx, min, maxWidthFor(window.innerWidth, max, min));
      widthRef.current = next;
      setWidth(next);
      persistWidth(next);
    },
    [min, max, persistWidth],
  );

  return { width, onPointerDown, nudgeWidth, min, max: ceiling };
}
