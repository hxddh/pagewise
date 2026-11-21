import { useEffect, useState } from "react";
import { getPageGeometry } from "../../lib/pdf";
import { pageRuns } from "../../lib/finding-anchors";
import { highlightBoxes, type HighlightBox } from "./search-highlight";

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
  const [boxes, setBoxes] = useState<HighlightBox[]>([]);

  useEffect(() => {
    if (!query) {
      setBoxes([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [runs, geometry] = await Promise.all([pageRuns(path, page), getPageGeometry(path, page)]);
        if (cancelled) return;
        const items = runs.items;
        setBoxes(highlightBoxes(items, query, geometry));
      } catch {
        // Highlighting is an aid, not the navigation itself — the jump already
        // happened, so a failure here leaves the page as it was.
        if (!cancelled) setBoxes([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, page, query]);

  const clampedFocus = boxes.length > 0 ? Math.min(Math.max(0, focusIndex), boxes.length - 1) : -1;

  useEffect(() => {
    if (clampedFocus >= 0 && boxes[clampedFocus]) {
      onFocusBox?.(boxes[clampedFocus]!);
    }
  }, [boxes, clampedFocus, onFocusBox]);

  if (boxes.length === 0) return null;

  return (
    <div className="search-highlight-layer" aria-hidden>
      {boxes.map((box, i) => (
        <span
          key={`${box.left}-${box.top}-${i}`}
          className={`search-highlight${i === clampedFocus ? " search-highlight-focus" : ""}`}
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
