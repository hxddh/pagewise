import { useEffect, useState } from "react";
import { getPageGeometry } from "../../lib/pdf";
import { pageRuns } from "../../lib/finding-anchors";
import { highlightOccurrences, type HighlightBox, type HighlightOccurrence } from "./search-highlight";

interface SearchHighlightProps {
  path: string;
  page: number;
  /** The query the reader jumped here for. Empty means nothing to show. */
  query: string;
  /** 0-based index of the currently focused match on this page. */
  focusIndex?: number;
  /** Reports the focused match's normalized box so the scroller can bring it into view. */
  onFocusBox?: (box: HighlightBox) => void;
}

export function SearchHighlight({
  path,
  page,
  query,
  focusIndex = 0,
  onFocusBox,
}: SearchHighlightProps) {
  const [items, setItems] = useState<HighlightOccurrence[]>([]);

  useEffect(() => {
    if (!query) {
      setItems([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [runs, geometry] = await Promise.all([pageRuns(path, page), getPageGeometry(path, page)]);
        if (cancelled) return;
        setItems(highlightOccurrences(runs.items, query, geometry));
      } catch {
        // Highlighting is an aid, not the navigation itself — the jump already
        // happened, so a failure here leaves the page as it was.
        if (!cancelled) setItems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, page, query]);

  const maxOccurrence = items.length > 0 ? items[items.length - 1]!.occurrence : -1;
  const clampedFocus = maxOccurrence >= 0 ? Math.min(Math.max(0, focusIndex), maxOccurrence) : -1;
  const focusedItem = clampedFocus >= 0 ? items.find((it) => it.occurrence === clampedFocus) : undefined;

  useEffect(() => {
    if (focusedItem) {
      onFocusBox?.(focusedItem.box);
    }
  }, [focusedItem, onFocusBox]);

  if (items.length === 0) return null;

  return (
    <div className="search-highlight-layer" aria-hidden>
      {items.map(({ box, occurrence }, i) => (
        <span
          key={`${box.left}-${box.top}-${i}`}
          className={`search-highlight${occurrence === clampedFocus ? " search-highlight-focus" : ""}`}
          style={{
            left: `${box.left * 100}%`,
            top: `${box.top * 100}%`,
            width: `${box.width * 100}%`,
            height: `${box.height * 100}%`,
          }}
        />
      ))}
    </div>
  );
}
