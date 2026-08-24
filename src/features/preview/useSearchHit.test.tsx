// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useSearchHit } from "./useSearchHit";

afterEach(cleanup);

/**
 * How long a search hit is worth marking.
 *
 * `PreviewPane` said in a comment that the hit was "cleared as soon as they
 * navigate away from it" and nothing cleared it. Because the highlight only
 * ever draws on its own page, the leak was invisible while the reader was
 * elsewhere — and reappeared every time they scrolled back past that page, for
 * the rest of the session, with no search running.
 */
describe("useSearchHit", () => {
  it("keeps the hit while the reader stays on its page", () => {
    const { result, rerender } = renderHook(({ page }) => useSearchHit(page), {
      initialProps: { page: 7 },
    });
    act(() => result.current[1]({ page: 7, query: "revenue" }));
    rerender({ page: 7 });
    expect(result.current[0]).toEqual({ page: 7, query: "revenue" });
  });

  it("forgets it once they have moved to another page", () => {
    const { result, rerender } = renderHook(({ page }) => useSearchHit(page), {
      initialProps: { page: 7 },
    });
    act(() => result.current[1]({ page: 7, query: "revenue" }));
    rerender({ page: 8 });
    expect(result.current[0]).toBeNull();
  });

  it("does not bring it back when they scroll past that page again", () => {
    // The actual symptom. Measured in a browser before this existed: search,
    // jump to page 7, scroll to the top, scroll back — the highlight returned.
    const { result, rerender } = renderHook(({ page }) => useSearchHit(page), {
      initialProps: { page: 7 },
    });
    act(() => result.current[1]({ page: 7, query: "revenue" }));
    rerender({ page: 1 });
    rerender({ page: 7 });
    expect(result.current[0]).toBeNull();
  });

  it("does not eat the hit that a jump just set", () => {
    // The trap in writing this: a jump changes the page AND sets the hit. An
    // effect that cleared on any change of either would wipe the highlight it
    // was handed, and the feature would look broken in the one case it exists
    // for. Both orderings are exercised because React may batch or not.
    const batched = renderHook(({ page }) => useSearchHit(page), { initialProps: { page: 1 } });
    act(() => {
      batched.result.current[1]({ page: 7, query: "revenue" });
      batched.rerender({ page: 7 });
    });
    expect(batched.result.current[0], "page and hit committed together").toEqual({
      page: 7,
      query: "revenue",
    });

    const staggered = renderHook(({ page }) => useSearchHit(page), { initialProps: { page: 1 } });
    staggered.rerender({ page: 7 });
    act(() => staggered.result.current[1]({ page: 7, query: "revenue" }));
    expect(staggered.result.current[0], "page first, hit a render later").toEqual({
      page: 7,
      query: "revenue",
    });
  });

  it("lets the caller clear it outright", () => {
    // A search that jumps with no query — the reader picked a page, not a hit.
    const { result } = renderHook(({ page }) => useSearchHit(page), {
      initialProps: { page: 3 },
    });
    act(() => result.current[1]({ page: 3, query: "x" }));
    act(() => result.current[1](null));
    expect(result.current[0]).toBeNull();
  });
});
