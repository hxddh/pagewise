import { useEffect, useState } from "react";
import { getPageGeometry } from "../../lib/pdf";
import type { PdfRect } from "../../lib/types";
import { pdfRectToBox, type HighlightBox } from "./search-highlight";

/** A citation the reader followed from an answer: where on the page its words are. */
export interface RevealedCitation {
  page: number;
  /** Bottom-left origin, as `page_text_items` reports them. */
  rects: PdfRect[];
  /** Distinguishes two clicks on the same citation, so the second one re-lights it. */
  nonce: number;
}

/**
 * Light up the words an answer quoted, on the page it cited.
 *
 * `pdfRectToBox`, not `topLeftRectToBox`: these rectangles came from
 * `page_text_items`, which is bottom-left — 9.2.3 is what confusing the two
 * costs.
 */
export function CitationHighlight({ path, page, rects }: { path: string; page: number; rects: PdfRect[] }) {
  const [boxes, setBoxes] = useState<HighlightBox[]>([]);

  useEffect(() => {
    let cancelled = false;
    void getPageGeometry(path, page).then(
      (geometry) => !cancelled && setBoxes(rects.map((r) => pdfRectToBox(r, geometry))),
      () => !cancelled && setBoxes([]),
    );
    return () => {
      cancelled = true;
    };
  }, [path, page, rects]);

  if (boxes.length === 0) return null;
  return (
    <div className="citation-highlight-layer" aria-hidden>
      {boxes.map((box, i) => (
        <span
          key={`${box.left}-${box.top}-${i}`}
          className="citation-highlight"
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
