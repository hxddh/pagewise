// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/pdf", () => ({ clearPageBitmapCache: () => {} }));
vi.mock("../../lib/preferences", () => ({ loadPreferences: async () => ({ previewQuality: "crisp" }) }));

import { usePdfViewer } from "./usePdfViewer";
import type { LoadedDocument } from "../../lib/types";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const doc = (path: string): LoadedDocument => ({ path, name: path, kind: "pdf", totalPages: 5, pages: [] });

describe("B19: the viewer (16.0)", () => {
  it("opens at the saved zoom, and a newly opened document too", () => {
    localStorage.setItem("pagewise.zoom", "1.5");
    const { result, rerender } = renderHook((p: { d: LoadedDocument }) => usePdfViewer({ doc: p.d, page: 1, onPageChange: () => {} }), {
      initialProps: { d: doc("/a.pdf") },
    });
    expect(result.current.zoom).toBe(1.5);
    rerender({ d: doc("/b.pdf") });
    expect(result.current.zoom).toBe(1.5);
  });

  it("does not turn the page for an arrow key something else already handled", () => {
    const onPageChange = vi.fn();
    renderHook(() => usePdfViewer({ doc: doc("/a.pdf"), page: 2, onPageChange }));
    const handle = document.createElement("div");
    document.body.appendChild(handle);
    handle.addEventListener("keydown", (e) => e.preventDefault());
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    handle.remove();
    expect(onPageChange).not.toHaveBeenCalled();
  });
});
