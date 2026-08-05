// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegionSelectLayer } from "./RegionSelectLayer";
import type { ClientRect } from "./selection-quote";

afterEach(cleanup);

/**
 * The page's position in the window. jsdom has no layout engine, so the page
 * box is what the test says it is — which is also what lets a test move the
 * page mid-drag, the thing scrolling does and flipping never did.
 */
function stubBox(node: Element, box: { left: number; top: number; width: number; height: number }) {
  node.getBoundingClientRect = () =>
    ({
      left: box.left,
      top: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
      width: box.width,
      height: box.height,
      x: box.left,
      y: box.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function setup() {
  const onRegion = vi.fn<(rect: ClientRect, pageBox: ClientRect) => void>();
  const { container } = render(<RegionSelectLayer active onRegion={onRegion} />);
  const layer = container.querySelector(".pdf-region-layer")!;
  // Pointer capture is not implemented in jsdom.
  layer.setPointerCapture = () => {};
  layer.releasePointerCapture = () => {};
  return { layer, onRegion };
}

describe("RegionSelectLayer", () => {
  it("reports the dragged rectangle", () => {
    const { layer, onRegion } = setup();
    stubBox(layer, { left: 100, top: 50, width: 600, height: 800 });

    fireEvent.pointerDown(layer, { button: 0, clientX: 150, clientY: 100 });
    fireEvent.pointerMove(layer, { clientX: 250, clientY: 200 });
    fireEvent.pointerUp(layer, { clientX: 250, clientY: 200 });

    expect(onRegion).toHaveBeenCalledTimes(1);
    const [rect, pageBox] = onRegion.mock.calls[0]!;
    expect(rect).toEqual({ left: 150, top: 100, width: 100, height: 100 });
    expect(pageBox).toEqual({ left: 100, top: 50, width: 600, height: 800 });
  });

  it("keeps the rectangle on the page when the document scrolls mid-drag", () => {
    const { layer, onRegion } = setup();
    stubBox(layer, { left: 100, top: 50, width: 600, height: 800 });

    fireEvent.pointerDown(layer, { button: 0, clientX: 150, clientY: 100 });

    // The wheel is not held by pointer capture: the page moves up 300px under
    // the pointer while the drag is still going. The reader's finger has not
    // moved relative to the page, so the rectangle must not move either.
    stubBox(layer, { left: 100, top: -250, width: 600, height: 800 });
    fireEvent.pointerMove(layer, { clientX: 250, clientY: -100 });
    fireEvent.pointerUp(layer, { clientX: 250, clientY: -100 });

    const [rect, pageBox] = onRegion.mock.calls[0]!;
    // 150,100 was 50,50 into the page; -100 is 150 into the page after the
    // scroll. Both corners are page-relative, so the box is 100x100 either way.
    expect(rect.width).toBe(100);
    expect(rect.height).toBe(100);
    expect(rect.left - pageBox.left).toBe(50);
    expect(rect.top - pageBox.top).toBe(50);
  });

  it("stops a drag that leaves the page at the page's edge", () => {
    const { layer, onRegion } = setup();
    stubBox(layer, { left: 100, top: 50, width: 600, height: 800 });

    // Down near the bottom-right, up well past both edges — onto the next page.
    fireEvent.pointerDown(layer, { button: 0, clientX: 600, clientY: 700 });
    fireEvent.pointerUp(layer, { clientX: 900, clientY: 1400 });

    const [rect, pageBox] = onRegion.mock.calls[0]!;
    expect(rect.left - pageBox.left).toBe(500);
    expect(rect.top - pageBox.top).toBe(650);
    // Clamped to the page's own width and height, not the drag's.
    expect(rect.width).toBe(100);
    expect(rect.height).toBe(150);
  });

  it("ignores a drag that is entirely off the page", () => {
    const { layer, onRegion } = setup();
    stubBox(layer, { left: 100, top: 50, width: 600, height: 800 });

    fireEvent.pointerDown(layer, { button: 0, clientX: 900, clientY: 1000 });
    fireEvent.pointerUp(layer, { clientX: 1100, clientY: 1200 });

    expect(onRegion).not.toHaveBeenCalled();
  });

  it("treats a drag shorter than the minimum as a click", () => {
    const { layer, onRegion } = setup();
    stubBox(layer, { left: 100, top: 50, width: 600, height: 800 });

    fireEvent.pointerDown(layer, { button: 0, clientX: 150, clientY: 100 });
    fireEvent.pointerUp(layer, { clientX: 153, clientY: 103 });

    expect(onRegion).not.toHaveBeenCalled();
  });

  it("draws nothing and takes no pointer events when inactive", () => {
    const onRegion = vi.fn();
    const { container } = render(<RegionSelectLayer active={false} onRegion={onRegion} />);
    expect(container.querySelector(".pdf-region-layer")).toBeNull();
  });

  it("clears the rubber band when the drag is cancelled", () => {
    const { layer, onRegion } = setup();
    stubBox(layer, { left: 100, top: 50, width: 600, height: 800 });

    fireEvent.pointerDown(layer, { button: 0, clientX: 150, clientY: 100 });
    fireEvent.pointerMove(layer, { clientX: 250, clientY: 200 });
    expect(layer.querySelector(".pdf-region-band")).not.toBeNull();

    fireEvent.pointerCancel(layer);
    expect(layer.querySelector(".pdf-region-band")).toBeNull();
    expect(onRegion).not.toHaveBeenCalled();
  });
});
