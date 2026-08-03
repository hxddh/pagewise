import { useEffect, useState } from "react";
import { getPageGeometry } from "../../lib/pdf";
import { isSafeLink } from "../../lib/safe-link";
import type { DocLink } from "../../lib/types";
import { pdfRectToBox, type HighlightBox } from "./search-highlight";

interface LinkLayerProps {
  path: string;
  page: number;
  /** Every link in the document; this layer draws the ones on `page`. */
  links: DocLink[];
  onActivate: (url: string) => void;
}

interface PlacedLink {
  url: string;
  box: HighlightBox;
}

/**
 * Make the links a PDF already contains clickable.
 *
 * The URLs come out of the document, which is untrusted input, so anything
 * outside the app's scheme allowlist is not drawn at all — an unclickable
 * region is a better answer than a clickable `javascript:`. Activating a link
 * asks first; `onActivate` owns that confirmation.
 */
export function LinkLayer({ path, page, links, onActivate }: LinkLayerProps) {
  const [placed, setPlaced] = useState<PlacedLink[]>([]);

  useEffect(() => {
    const onPage = links.filter((l) => l.page === page && isSafeLink(l.url));
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
          onPage.map((link) => ({
            url: link.url,
            box: pdfRectToBox(link.rect, geometry),
          })),
        );
      } catch {
        // The page still reads fine without clickable links.
        if (!cancelled) setPlaced([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, page, links]);

  if (placed.length === 0) return null;

  return (
    <div className="pdf-link-layer">
      {placed.map((link, i) => (
        <button
          key={`${link.url}-${i}`}
          type="button"
          className="pdf-link"
          title={link.url}
          aria-label={link.url}
          style={{
            left: `${link.box.left * 100}%`,
            top: `${link.box.top * 100}%`,
            width: `${link.box.width * 100}%`,
            height: `${link.box.height * 100}%`,
          }}
          onClick={(e) => {
            // The text layer sits under this and owns selection; a click meant
            // for the link should not also start one.
            e.stopPropagation();
            onActivate(link.url);
          }}
        />
      ))}
    </div>
  );
}
