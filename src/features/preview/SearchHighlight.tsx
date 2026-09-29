import { useEffect, useState } from "react";
import { getPageGeometry } from "../../lib/pdf";
import { pageRuns } from "../../lib/finding-anchors";
import { highlightBoxes, type HighlightBox } from "./search-highlight";

interface SearchHighlightProps {
  path: string;
  page: number;
  /** The query the reader jumped here for. Empty means nothing to show. */
  query: string;
}

/**
 * Mark where a search hit is on the page.
 *
 * Jumping to page 42 and leaving the reader to find the phrase is most of the
 * work still undone. Boxes cover the line a hit is on rather than the exact
 * characters: the extractor reports runs, not glyph advances. On a scan the
 * runs are OCR's words (14.0), through the same `pageRuns` citations use.
 */
export function SearchHighlight({ path, page, query }: SearchHighlightProps) {
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

  if (boxes.length === 0) return null;

  return (
    <div className="search-highlight-layer" aria-hidden>
      {boxes.map((box, i) => (
        <span
          key={`${box.left}-${box.top}-${i}`}
          className="search-highlight"
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
