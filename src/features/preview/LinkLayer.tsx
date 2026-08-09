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
  label: string;
  box: HighlightBox;
}

/**
 * What the link says out loud.
 *
 * A bare URL is what a screen reader had to read out before — for a link whose
 * visible words are "the specification", announcing the raw href is the least
 * useful thing available. The line the link sits on names it the way the page
 * does; the URL still follows, since where a link goes is worth hearing.
 */
function linkLabel(context: string, url: string): string {
  const trimmed = context.trim();
  return trimmed ? `${trimmed} — ${url}` : url;
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
            label: linkLabel(link.context, link.url),
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
        // raw-button: a hit area positioned over the page at the link's own PDF coordinates
        <button
          key={`${link.url}-${i}`}
          type="button"
          className="pdf-link"
          title={link.label}
          aria-label={link.label}
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
