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

/**
 * A drag in progress, in page pixels — the page's own top-left, not the
 * window's.
 *
 * Viewport coordinates were what this held while the preview showed one page
 * at a time and that page could not move. On a scrolling surface the page
 * moves under the pointer: pointer capture holds pointer events, but not the
 * wheel, so a scroll mid-drag left the start corner in one frame of reference
 * and the page box read at the end in another, offsetting the whole rectangle
 * by however far the document had scrolled. Page pixels cannot drift.
 */
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

  const at = (e: { clientX: number; clientY: number; currentTarget: HTMLDivElement }) => {
    const box = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };

  const finish = (final: Band | null) => {
    setBand(null);
    const box = ref.current?.getBoundingClientRect();
    if (!final || !box) return;
    // Pointer capture keeps the whole drag on the page it started on, so it can
    // be dragged off that page's edge — onto the next page, or into the gutter.
    // A region belongs to the page it was drawn on, so it stops at that page.
    const left = clamp(Math.min(final.x0, final.x1), 0, box.width);
    const right = clamp(Math.max(final.x0, final.x1), 0, box.width);
    const top = clamp(Math.min(final.y0, final.y1), 0, box.height);
    const bottom = clamp(Math.max(final.y0, final.y1), 0, box.height);
    const width = right - left;
    const height = bottom - top;
    if (width < MIN_DRAG_PX || height < MIN_DRAG_PX) return;
    onRegion(
      { left: box.left + left, top: box.top + top, width, height },
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
        const { x, y } = at(e);
        setBand({ x0: x, y0: y, x1: x, y1: y });
      }}
      onPointerMove={(e) => {
        if (!band) return;
        const { x, y } = at(e);
        setBand({ ...band, x1: x, y1: y });
      }}
      onPointerUp={(e) => {
        if (!band) return;
        const { x, y } = at(e);
        finish({ ...band, x1: x, y1: y });
      }}
      // A drag that leaves the window, or is taken over by something else, must
      // not leave a rubber band painted on the page forever.
      onPointerCancel={() => finish(null)}
    >
      {band && (
        <div
          className="pdf-region-band"
          style={{
            left: Math.min(band.x0, band.x1),
            top: Math.min(band.y0, band.y1),
            width: Math.abs(band.x1 - band.x0),
            height: Math.abs(band.y1 - band.y0),
          }}
        />
      )}
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
