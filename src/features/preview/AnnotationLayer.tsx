import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { getPageGeometry } from "../../lib/pdf";
import type { DocAnnotation } from "../../lib/pdf-annotations";
import { pdfRectToBox, type HighlightBox } from "./search-highlight";

interface AnnotationLayerProps {
  path: string;
  page: number;
  annotations: readonly DocAnnotation[];
}

interface PlacedAnnotation {
  note: DocAnnotation;
  box: HighlightBox;
}

/**
 * Notes somebody else already wrote on this page.
 *
 * Deliberately not the same thing as the reader's own marks, and deliberately
 * not drawn like them. A mark is what you did; this is what the person who sent
 * you the file did, and a reader who cannot tell the two apart will eventually
 * answer for a claim they never made. `MarkLayer` fills; this outlines, with a
 * corner tab where a note has words on it.
 *
 * `rect` here is bottom-left origin — the convention links and text runs use —
 * so it goes through `pdfRectToBox`. The reader's own marks are stored top-left
 * and need `topLeftRectToBox` instead. The two functions have the same
 * signature and the same return type, so picking the wrong one type-checks and
 * mirrors every box about the middle of the page; 9.2.3 is what that cost.
 */
export function AnnotationLayer({ path, page, annotations }: AnnotationLayerProps) {
  const { t } = useI18n();
  const [placed, setPlaced] = useState<PlacedAnnotation[]>([]);

  useEffect(() => {
    const onPage = annotations.filter((a) => a.page === page);
    if (onPage.length === 0) {
      setPlaced([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const geometry = await getPageGeometry(path, page);
        if (cancelled) return;
        setPlaced(onPage.map((note) => ({ note, box: pdfRectToBox(note.rect, geometry) })));
      } catch {
        // The page still reads fine without other people's notes drawn on it.
        if (!cancelled) setPlaced([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, page, annotations]);

  if (placed.length === 0) return null;

  return (
    <div className="pdf-annotation-layer">
      {placed.map(({ note, box }) => (
        <div
          key={note.id}
          className={`pdf-annotation pdf-annotation-${note.subtype.toLowerCase()}${
            note.contents ? " pdf-annotation-noted" : ""
          }`}
          title={
            note.author
              ? t("annotations.byAuthor", { author: note.author, text: note.contents || note.quoted })
              : note.contents || note.quoted
          }
          aria-label={t("annotations.fromDocument", {
            text: note.contents || note.quoted,
          })}
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
