// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettled } from "./use-settled";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSettled", () => {
  it("starts at the value it is given", () => {
    const { result } = renderHook(() => useSettled(1, 500));
    expect(result.current).toBe(1);
  });

  it("holds the old value until the new one stops changing", () => {
    const { result, rerender } = renderHook(({ page }) => useSettled(page, 500), {
      initialProps: { page: 1 },
    });

    rerender({ page: 2 });
    expect(result.current).toBe(1);

    act(() => void vi.advanceTimersByTime(500));
    expect(result.current).toBe(2);
  });

  it("skips everything scrolled past — this is what a page costs money for", () => {
    const seen: number[] = [];
    const { rerender } = renderHook(
      ({ page }) => {
        const settled = useSettled(page, 500);
        if (seen[seen.length - 1] !== settled) seen.push(settled);
        return settled;
      },
      { initialProps: { page: 1 } },
    );

    // Scrolling through a 200-page scan. Each of these pages, indexed, is a
    // billed vision call; only the one the reader stops on is being read.
    for (let page = 2; page <= 200; page++) {
      rerender({ page });
      act(() => void vi.advanceTimersByTime(20));
    }
    act(() => void vi.advanceTimersByTime(500));

    expect(seen).toEqual([1, 200]);
  });

  it("reports nothing new when the reader comes back before it settles", () => {
    const { result, rerender } = renderHook(({ page }) => useSettled(page, 500), {
      initialProps: { page: 4 },
    });
    act(() => void vi.advanceTimersByTime(500));

    rerender({ page: 5 });
    rerender({ page: 6 });
    rerender({ page: 4 });
    act(() => void vi.advanceTimersByTime(500));

    expect(result.current).toBe(4);
  });

  it("drops a pending value when it unmounts", () => {
    const { rerender, unmount } = renderHook(({ page }) => useSettled(page, 500), {
      initialProps: { page: 1 },
    });
    rerender({ page: 2 });
    unmount();

    // Nothing is left to fire: a timer surviving the preview would index a page
    // of a document that is no longer open.
    expect(vi.getTimerCount()).toBe(0);
  });
});
