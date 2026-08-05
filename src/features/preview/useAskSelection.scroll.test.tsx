// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useRef } from "react";
import { useAskSelection } from "./useAskSelection";

/**
 * The selection's position has to follow the page.
 *
 * While the preview flipped, a selection could not move once it was made, so
 * measuring it once measured it forever. On a scrolling surface the passage
 * slides away under the buttons anchored to it — and scrolling does not fire
 * `selectionchange`, so nothing told them.
 */

let pageTop = 100;

function buildPage(container: HTMLElement) {
  const slot = document.createElement("div");
  slot.className = "pdf-page-slot";
  slot.dataset.page = "3";
  const text = document.createTextNode("a passage worth asking about");
  slot.appendChild(text);
  container.appendChild(slot);
  slot.getBoundingClientRect = () =>
    ({ left: 40, top: pageTop, width: 600, height: 800, right: 640, bottom: pageTop + 800 }) as DOMRect;
  return { slot, text };
}

function stubSelection(text: Node) {
  const rects = [
    { left: 60, top: pageTop + 20, width: 200, height: 14 } as DOMRect,
  ];
  const range = {
    getBoundingClientRect: () => rects[0]!,
    getClientRects: () => rects as unknown as DOMRectList,
  };
  Object.defineProperty(window, "getSelection", {
    configurable: true,
    value: () => ({
      isCollapsed: false,
      anchorNode: text,
      focusNode: text,
      toString: () => "a passage worth asking about",
      getRangeAt: () => range,
    }),
  });
}

async function frame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

beforeEach(() => {
  pageTop = 100;
  document.body.innerHTML = "";
});

afterEach(cleanup);

describe("useAskSelection while the document scrolls", () => {
  it("moves the anchor with the page instead of leaving it pinned to the window", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { slot, text } = buildPage(container);
    stubSelection(text);

    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(container);
      return useAskSelection(ref, true);
    });

    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    await frame();

    expect(result.current[0]?.page).toBe(3);
    expect(result.current[0]?.y).toBe(120);

    // Scroll the document 60px: the page moves up, and so does the passage.
    pageTop = 40;
    slot.getBoundingClientRect = () =>
      ({ left: 40, top: pageTop, width: 600, height: 800, right: 640, bottom: pageTop + 800 }) as DOMRect;
    stubSelection(text);
    act(() => {
      container.dispatchEvent(new Event("scroll"));
    });
    await frame();

    expect(result.current[0]?.y).toBe(60);
    expect(result.current[0]?.pageBox.top).toBe(40);
  });

  it("keeps the rect and the page box in one frame of reference", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { text } = buildPage(container);
    stubSelection(text);

    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(container);
      return useAskSelection(ref, true);
    });
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    await frame();

    const sel = result.current[0]!;
    // What a mark is placed from: the offset of the selection within its page.
    expect(sel.rect.top - sel.pageBox.top).toBe(20);
    expect(sel.rect.left - sel.pageBox.left).toBe(20);
  });
});
