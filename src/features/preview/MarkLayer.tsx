import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { getPageGeometry } from "../../lib/pdf";
import { marksOnPage, type Mark } from "../../lib/mark-store";
import { pdfRectToBox, type HighlightBox } from "./search-highlight";

interface MarkLayerProps {
  path: string;
  page: number;
  /** Bumped by the owner when marks change, so the layer re-places them. */
  revision: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

interface PlacedMark {
  mark: Mark;
  boxes: HighlightBox[];
}

/**
 * Draw the reader's marks over the page.
 *
 * Same shape as `LinkLayer` and `SearchHighlight`: rectangles in PDF points go
 * through `pdfRectToBox` and come out as fractions of the page, so zoom, window
 * size and device pixel ratio need no recomputation.
 */
export function MarkLayer({ path, page, revision, selectedId, onSelect }: MarkLayerProps) {
  const { t } = useI18n();
  const [placed, setPlaced] = useState<PlacedMark[]>([]);

  useEffect(() => {
    const onPage = marksOnPage(path, page);
    if (onPage.length === 0) {
      setPlaced([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const geometry = await getPageGeometry(path, page);
        if (cancelled) return;
        setPlaced(
          onPage.map((mark) => ({
            mark,
            boxes: mark.rects.map((rect) => pdfRectToBox(rect, geometry)),
          })),
        );
      } catch {
        // The page still reads fine without its marks drawn.
        if (!cancelled) setPlaced([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, page, revision]);

  if (placed.length === 0) return null;

  return (
    <div className="pdf-mark-layer">
      {placed.map(({ mark, boxes }) =>
        boxes.map((box, i) => (
          // raw-button: a hit area positioned over the page at the mark's own PDF coordinates
          <button
            key={`${mark.id}-${i}`}
            type="button"
            // A region mark is an outline, not a wash: filling it would hide
            // the figure the reader boxed in order to see it.
            className={`pdf-mark pdf-mark-${mark.kind ?? "text"}${
              mark.note ? " pdf-mark-noted" : ""
            }${mark.id === selectedId ? " pdf-mark-selected" : ""}`}
            title={mark.note || mark.text}
            aria-label={
              mark.note
                ? t("marks.markWithNote", { note: mark.note })
                : t("marks.markPlain", { text: mark.text.slice(0, 80) })
            }
            style={{
              left: `${box.left * 100}%`,
              top: `${box.top * 100}%`,
              width: `${box.width * 100}%`,
              height: `${box.height * 100}%`,
            }}
            onClick={(e) => {
              // The text layer below owns selection; a click meant for a mark
              // should not also start one.
              e.stopPropagation();
              onSelect(mark.id === selectedId ? null : mark.id);
            }}
          />
        )),
      )}
    </div>
  );
}
