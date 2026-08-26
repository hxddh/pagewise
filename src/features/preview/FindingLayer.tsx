import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { getPageGeometry } from "../../lib/pdf";
import { findingsOnPage, isSuperseded, getFindings, type Finding } from "../../lib/finding-store";
import { placeFinding, type FindingAnchor } from "../../lib/finding-anchors";
import { pdfRectToBox, type HighlightBox } from "./search-highlight";

interface FindingLayerProps {
  path: string;
  page: number;
  /** Bumped by the owner when the record changes, so the layer re-places it. */
  revision: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

interface PlacedFinding {
  finding: Finding;
  boxes: HighlightBox[];
  /** Where the margin note sits: the top of the passage, as a page fraction. */
  noteTop: number;
}

/** Most notes drawn in one page's margin. Beyond this they stack illegibly. */
const MAX_MARGIN_NOTES = 12;

/**
 * What the assistant worked out, drawn beside the text it came from.
 *
 * `RecordPanel` said this could not be done — "the 9.0 design promised findings
 * drawn beside the text they came from. They cannot be: a finding is anchored
 * to page numbers, not to a rectangle, because the assistant reads page text
 * and has no coordinates." All of that is still true. What changed is that the
 * assistant does not have to supply the rectangle: it supplies the wording, and
 * `placeFinding` looks the wording up in the page's own text runs. The anchor
 * is derived from the document, not asserted by the model.
 *
 * A finding that cannot be placed draws nothing here. It is not silently
 * dropped — the record panel shows it as a claim whose evidence is not on the
 * page it cites, which is the more important half of this feature.
 *
 * THIRD INK, DELIBERATELY. Yellow is the reader's highlighter, teal is a note
 * somebody else left in the file, and this is neither: it is what the assistant
 * concluded. A reader who cannot tell the three apart will eventually answer
 * for a claim they never made and never checked — the same argument
 * `--annotation` was added under, applied to the one remaining author.
 *
 * `page_text_items` reports bottom-left origin, so these go through
 * `pdfRectToBox`. The reader's own marks are top-left and need
 * `topLeftRectToBox`; the two have the same signature and 9.2.3 is what
 * confusing them cost.
 */
export function FindingLayer({ path, page, revision, selectedId, onSelect }: FindingLayerProps) {
  const { t } = useI18n();
  const [placed, setPlaced] = useState<PlacedFinding[]>([]);

  useEffect(() => {
    const all = getFindings(path);
    const onPage = findingsOnPage(path, page).filter(
      // Struck by the reader, or replaced by a later claim. Both stay listed in
      // the record, where the history is the point; neither is drawn on the
      // page as though it still stood.
      (f) => !f.struck && !isSuperseded(all, f.id),
    );
    if (onPage.length === 0) {
      setPlaced([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const geometry = await getPageGeometry(path, page);
        if (cancelled) return;
        const out: PlacedFinding[] = [];
        for (const finding of onPage) {
          const placement = await placeFinding(path, finding);
          if (cancelled) return;
          if (placement.status !== "located") continue;
          const anchor: FindingAnchor = placement.anchor;
          // Located on one of the finding's pages — but not necessarily this
          // one, when a claim cites several. Only the page carrying the words
          // draws them.
          if (anchor.page !== page) continue;
          const boxes = anchor.rects.map((rect) => pdfRectToBox(rect, geometry));
          const bounds = pdfRectToBox(anchor.bounds, geometry);
          out.push({ finding, boxes, noteTop: bounds.top });
        }
        if (!cancelled) setPlaced(out);
      } catch {
        // The page reads fine without the record drawn on it.
        if (!cancelled) setPlaced([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, page, revision]);

  if (placed.length === 0) return null;

  return (
    <div className="pdf-finding-layer">
      {placed.map(({ finding, boxes }) =>
        boxes.map((box, i) => (
          // raw-button: a hit area positioned over the page at the coordinates
          // the finding's own wording was located at
          <button
            key={`${finding.id}-${i}`}
            type="button"
            className={`pdf-finding${finding.id === selectedId ? " pdf-finding-selected" : ""}`}
            title={finding.claim}
            aria-label={t("record.onPage", { claim: finding.claim })}
            style={{
              left: `${box.left * 100}%`,
              top: `${box.top * 100}%`,
              width: `${box.width * 100}%`,
              height: `${box.height * 100}%`,
            }}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(finding.id === selectedId ? null : finding.id);
            }}
          />
        )),
      )}
      <div className="pdf-finding-margin" aria-hidden>
        {placed.slice(0, MAX_MARGIN_NOTES).map(({ finding, noteTop }) => (
          <span
            key={finding.id}
            className={`pdf-finding-tab${
              finding.id === selectedId ? " pdf-finding-tab-selected" : ""
            }`}
            style={{ top: `${noteTop * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}
