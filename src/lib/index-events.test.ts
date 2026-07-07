import { describe, expect, it, vi } from "vitest";
import {
  clearDocumentIndexState,
  clearPageIndexState,
  emitPageIndex,
  getPageIndexState,
  subscribePageIndex,
} from "./index-events";

describe("index-events", () => {
  it("notifies idle when a page index state is cleared, without re-storing it (L3)", () => {
    emitPageIndex({ path: "/a.pdf", page: 1, status: "done", source: "vision" });
    const listener = vi.fn();
    const unsub = subscribePageIndex(listener);
    clearPageIndexState("/a.pdf", 1);
    unsub();
    // Listeners still hear idle so the UI resets...
    expect(listener).toHaveBeenCalledWith({ path: "/a.pdf", page: 1, status: "idle" });
    // ...but the state is actually gone (map shrinks instead of leaking an idle entry).
    expect(getPageIndexState("/a.pdf", 1)).toBeUndefined();
  });

  it("clearDocumentIndexState drops every page's stored state (L3)", () => {
    emitPageIndex({ path: "/b.pdf", page: 1, status: "done", source: "vision" });
    emitPageIndex({ path: "/b.pdf", page: 2, status: "failed", source: "vision" });
    emitPageIndex({ path: "/keep.pdf", page: 1, status: "done", source: "vision" });

    clearDocumentIndexState("/b.pdf");

    expect(getPageIndexState("/b.pdf", 1)).toBeUndefined();
    expect(getPageIndexState("/b.pdf", 2)).toBeUndefined();
    // Other documents are untouched.
    expect(getPageIndexState("/keep.pdf", 1)?.status).toBe("done");
  });
});
