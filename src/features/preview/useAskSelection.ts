import { useEffect, useState, type RefObject } from "react";

export interface AskSelection {
  text: string;
  /** Viewport px: horizontal center and top of the selection rect. */
  x: number;
  y: number;
}

const MAX_QUOTE = 500;

/**
 * Track a non-empty text selection inside `containerRef` (the PDF text layer's
 * scroll container) and expose its trimmed text + a viewport position, so a
 * floating "ask about this" affordance can be shown. Returns the current
 * selection (or null) and a clear function.
 */
export function useAskSelection<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  enabled: boolean,
): [AskSelection | null, () => void] {
  const [sel, setSel] = useState<AskSelection | null>(null);

  useEffect(() => {
    if (!enabled) {
      setSel(null);
      return;
    }
    const update = () => {
      const s = window.getSelection();
      const container = containerRef.current;
      if (!s || s.isCollapsed || !container) return setSel(null);
      const { anchorNode, focusNode } = s;
      if (
        !anchorNode ||
        !focusNode ||
        !container.contains(anchorNode) ||
        !container.contains(focusNode)
      ) {
        return setSel(null);
      }
      const text = s.toString().replace(/\s+/g, " ").trim();
      if (text.length < 2) return setSel(null);
      const rect = s.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return setSel(null);
      setSel({
        text: text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}…` : text,
        x: rect.left + rect.width / 2,
        y: rect.top,
      });
    };
    // selectionchange fires rapidly during a drag; coalesce to one rAF.
    let raf = 0;
    const onChange = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [containerRef, enabled]);

  return [sel, () => setSel(null)];
}
