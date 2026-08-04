import { useRef, useState } from "react";
import type { ClientRect } from "./selection-quote";

interface RegionSelectLayerProps {
  /** Off means the layer takes no pointer events at all. */
  active: boolean;
  /** Viewport-pixel rectangle of the completed drag. */
  onRegion: (rect: ClientRect, pageBox: ClientRect) => void;
}

/** A drag smaller than this is a click, not a region. */
const MIN_DRAG_PX = 8;

interface Band {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Drag a box on the page to mark it.
 *
 * Text marking needs a text layer, and a scanned page has none — measured, zero
 * selectable runs — so on exactly the pages vision indexing pays for, nothing
 * could be marked at all. The same is true of every figure and chart.
 *
 * Inactive, this draws nothing and takes no pointer events, so selecting text,
 * clicking a link and clicking an existing mark behave as before.
 */
export function RegionSelectLayer({ active, onRegion }: RegionSelectLayerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [band, setBand] = useState<Band | null>(null);

  if (!active) return null;

  const finish = (final: Band | null) => {
    setBand(null);
    const box = ref.current?.getBoundingClientRect();
    if (!final || !box) return;
    const left = Math.min(final.x0, final.x1);
    const top = Math.min(final.y0, final.y1);
    const width = Math.abs(final.x1 - final.x0);
    const height = Math.abs(final.y1 - final.y0);
    if (width < MIN_DRAG_PX || height < MIN_DRAG_PX) return;
    onRegion(
      { left, top, width, height },
      { left: box.left, top: box.top, width: box.width, height: box.height },
    );
  };

  return (
    <div
      ref={ref}
      className="pdf-region-layer"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // The page sits in a scroll container and the canvas is draggable;
        // without this the drag scrolls or drags an image instead.
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setBand({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
      }}
      onPointerMove={(e) => {
        if (!band) return;
        setBand({ ...band, x1: e.clientX, y1: e.clientY });
      }}
      onPointerUp={(e) => {
        if (!band) return;
        finish({ ...band, x1: e.clientX, y1: e.clientY });
      }}
      // A drag that leaves the window, or is taken over by something else, must
      // not leave a rubber band painted on the page forever.
      onPointerCancel={() => finish(null)}
    >
      {band && (
        <div
          className="pdf-region-band"
          style={{
            left: Math.min(band.x0, band.x1) - (ref.current?.getBoundingClientRect().left ?? 0),
            top: Math.min(band.y0, band.y1) - (ref.current?.getBoundingClientRect().top ?? 0),
            width: Math.abs(band.x1 - band.x0),
            height: Math.abs(band.y1 - band.y0),
          }}
        />
      )}
    </div>
  );
}
