import { useEffect } from "react";
import { setOverlayOpen } from "../lib/overlay-state";

/** Registers an open overlay so preview shortcuts stay suspended. */
export function useOverlayLock(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    setOverlayOpen(true);
    return () => setOverlayOpen(false);
  }, [open]);
}
