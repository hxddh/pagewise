import { afterEach, describe, expect, it, vi } from "vitest";
import { yieldToUi } from "./yield-to-ui";

describe("yieldToUi", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("resolves via setTimeout when the document is hidden (rAF may be paused)", async () => {
    vi.stubGlobal("document", { hidden: true });
    // If this used rAF it could hang; a hidden-path yield must resolve on a macrotask.
    await expect(yieldToUi()).resolves.toBeUndefined();
  });

  it("resolves via the timeout fallback when rAF never fires", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { hidden: false });
    // rAF that never invokes its callback (simulates an occluded window mid-run).
    vi.stubGlobal("requestAnimationFrame", () => 0 as unknown as number);

    const p = yieldToUi();
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(60);
    expect(settled).toBe(true);
  });
});
