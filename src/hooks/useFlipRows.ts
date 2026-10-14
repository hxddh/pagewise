import { useLayoutEffect, useRef, type RefObject } from "react";

/** The duration of a list movement. One step of the app's motion scale. */
const MOVE_MS = 160;
const RISE_PX = 6;

/**
 * First, Last, Invert, Play: a list whose rows move animates the movement
 * instead of teleporting (19.0).
 *
 * When an answer lands, a record entry is struck, or a mark is deleted, the
 * rows below it shift — and until 19.0 they shifted in one frame, which reads
 * as the list jumping rather than as something being added. FLIP is the honest
 * fix: measure where every row was, let React lay out where it is now, apply
 * the difference as a transform, and play it back to zero. Layout is never
 * touched, so nothing about the page's own geometry moves.
 *
 * The reader who asked for less motion gets none: `prefers-reduced-motion` is
 * read here, because this runs in JavaScript and the stylesheet's global block
 * cannot reach it. A row that merely appears (no previous position) rises into
 * place — only after the list has rendered once, so opening a conversation does
 * not animate a hundred turns in.
 *
 * Rows are identified by `data-flip-key` (falling back to `data-message-id`),
 * which is the same key React reconciles them by.
 *
 * Positions come from `offsetTop`, not `getBoundingClientRect`: a scroll moves
 * every rect on screen, and a list that animated its rows every time the reader
 * scrolled it would be worse than one that jumped. `offsetTop` is the row's
 * place in the layout, which is the only thing this is about.
 */
export function useFlipRows(
  containerRef: RefObject<HTMLElement | null>,
  selector: string,
  revision: unknown,
): void {
  const rects = useRef(new Map<string, { top: number }>());

  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const next = new Map<string, { top: number }>();
    const hadRows = rects.current.size > 0;
    root.querySelectorAll<HTMLElement>(selector).forEach((row) => {
      const key = row.dataset.flipKey ?? row.dataset.messageId;
      if (!key) return;
      const top = row.offsetTop;
      next.set(key, { top });
      if (reduced) return;
      const prev = rects.current.get(key);
      if (prev) {
        const dy = prev.top - top;
        if (Math.abs(dy) < 1) return;
        row.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
          duration: MOVE_MS,
          easing: "ease",
        });
      } else if (hadRows) {
        row.animate(
          [
            { opacity: 0, transform: `translateY(${RISE_PX}px)` },
            { opacity: 1, transform: "none" },
          ],
          { duration: MOVE_MS, easing: "ease" },
        );
      }
    });
    rects.current = next;
  }, [containerRef, selector, revision]);
}
