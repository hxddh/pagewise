// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedDocument } from "../../lib/types";

vi.mock("../../lib/pdf", () => ({ clearPageBitmapCache: () => {} }));
vi.mock("../../lib/preferences", () => ({
  loadPreferences: () => Promise.resolve({ previewQuality: "crisp" }),
}));

const { usePdfViewer } = await import("./usePdfViewer");

const SCROLL_HEIGHT = 20_000;

function doc(totalPages: number): LoadedDocument {
  return {
    kind: "pdf",
    path: "/doc.pdf",
    name: "doc.pdf",
    totalPages,
    pages: [],
  } as unknown as LoadedDocument;
}

/** A scroll container with a size, which jsdom does not give one. */
function stubScroller() {
  const node = document.createElement("div");
  Object.defineProperty(node, "clientHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => SCROLL_HEIGHT });
  node.scrollTo = vi.fn();
  node.scrollBy = vi.fn();
  return node;
}

function press(key: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(cleanup);

describe("usePdfViewer keyboard", () => {
  it("Home goes to the start of the document, not to the page it is already on", () => {
    const onPageChange = vi.fn();
    const node = stubScroller();
    const { result } = renderHook(() =>
      usePdfViewer({ doc: doc(50), page: 1, onPageChange }),
    );
    act(() => result.current.bindScroller(node));

    // Halfway down page 1: the page number is already 1, which is exactly the
    // case where asking to "go to page 1" used to do nothing at all.
    press("Home");

    expect(node.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
  });

  it("End goes to the end of the document, not to the top of the last page", () => {
    const onPageChange = vi.fn();
    const node = stubScroller();
    const { result } = renderHook(() =>
      usePdfViewer({ doc: doc(50), page: 50, onPageChange }),
    );
    act(() => result.current.bindScroller(node));

    press("End");

    expect(node.scrollTo).toHaveBeenCalledWith({ top: SCROLL_HEIGHT, behavior: "auto" });
  });

  it("Page Up and Page Down move by a screenful", () => {
    const node = stubScroller();
    const { result } = renderHook(() =>
      usePdfViewer({ doc: doc(50), page: 5, onPageChange: vi.fn() }),
    );
    act(() => result.current.bindScroller(node));

    press("PageDown");
    expect(node.scrollBy).toHaveBeenCalledWith({ top: 536, behavior: "auto" });

    press("PageUp");
    expect(node.scrollBy).toHaveBeenLastCalledWith({ top: -536, behavior: "auto" });
  });

  it("the arrow keys still move one page at a time", () => {
    const onPageChange = vi.fn();
    const node = stubScroller();
    const { result } = renderHook(() =>
      usePdfViewer({ doc: doc(50), page: 5, onPageChange }),
    );
    act(() => result.current.bindScroller(node));

    press("ArrowRight");
    expect(onPageChange).toHaveBeenLastCalledWith(6);

    press("ArrowLeft");
    expect(onPageChange).toHaveBeenLastCalledWith(4);
  });

  it("does not steal keys while the reader is typing", () => {
    const onPageChange = vi.fn();
    const node = stubScroller();
    const { result } = renderHook(() =>
      usePdfViewer({ doc: doc(50), page: 5, onPageChange }),
    );
    act(() => result.current.bindScroller(node));

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });

    expect(node.scrollTo).not.toHaveBeenCalled();
    input.remove();
  });
});
