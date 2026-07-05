import { describe, expect, it, vi } from "vitest";
import {
  clearPageIndexState,
  emitPageIndex,
  getPageIndexState,
  subscribePageIndex,
} from "./index-events";

describe("index-events", () => {
  it("emits idle when a page index state is cleared", () => {
    emitPageIndex({ path: "/a.pdf", page: 1, status: "done", source: "vision" });
    const listener = vi.fn();
    const unsub = subscribePageIndex(listener);
    clearPageIndexState("/a.pdf", 1);
    unsub();
    expect(listener).toHaveBeenCalledWith({ path: "/a.pdf", page: 1, status: "idle" });
    expect(getPageIndexState("/a.pdf", 1)?.status).toBe("idle");
  });
});
