import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(active: boolean, containerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!active) return;
    const root = containerRef.current;
    if (!root) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        // Must be actually rendered/visible. `offsetParent !== null` excludes
        // display:none; `getClientRects().length > 0` also excludes elements
        // hidden via other means (e.g. inactive tab panels).
        (el) => el.offsetParent !== null && el.getClientRects().length > 0,
      );

    // Deferred so the overlay's children exist, and cancelled on the way out:
    // an overlay opened and closed within the same tick would otherwise pull
    // focus back to an element that is no longer on screen.
    const focusFirst = window.setTimeout(() => {
      const first = focusables()[0];
      first?.focus();
    }, 0);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    root.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusFirst);
      root.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [active, containerRef]);
}
