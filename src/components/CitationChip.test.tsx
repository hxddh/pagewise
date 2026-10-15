// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** What the local check answers for the chip; each test sets it. */
const state = vi.hoisted(() => ({ check: null as unknown }));

vi.mock("../lib/citation-check", () => ({
  cachedCitationCheck: () => state.check,
  checkCitation: () => new Promise(() => {}),
  withClaim: (c: unknown) => c,
}));

vi.mock("../i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));

import { CitationChip, CitationContext, type CitationEnv } from "./CitationChip";

afterEach(cleanup);

const link = { pages: [2], quote: "a quoted passage", claim: "a claim" };
const env: CitationEnv = { path: "/doc.pdf", totalPages: 5, onReveal: () => {} };

describe("B11: a chip on screen when the document arrives (16.0)", () => {
  it("renders inert without a document, then as a chip, without a hooks error", () => {
    const view = render(
      <CitationContext.Provider value={null}>
        <CitationChip link={link} />
      </CitationContext.Provider>,
    );
    expect(view.container.querySelector(".cite-inert")).not.toBeNull();
    expect(() =>
      view.rerender(
        <CitationContext.Provider value={env}>
          <CitationChip link={link} />
        </CitationContext.Provider>,
      ),
    ).not.toThrow();
    expect(view.container.querySelector("button.cite")).not.toBeNull();
  });

  it("says a quote too short to check is too short, rather than showing nothing (20.0)", () => {
    state.check = { status: "tooShort" };
    const view = render(
      <CitationContext.Provider value={env}>
        <CitationChip link={{ pages: [2], quote: "fell", claim: "Revenue fell." }} />
      </CitationContext.Provider>,
    );
    const chip = view.container.querySelector("button.cite")!;
    expect(chip.getAttribute("title")).toContain("trust.tooShort.long");
    expect(chip.className).toContain("cite-tooShort");
  });
});

describe("a chip with nothing to light says why (21.0)", () => {
  // A red chip used to turn the page and clear the highlight: "not on this
  // page" read as a lookup that worked, the reason only in the tooltip.
  const click = (check: unknown) => {
    state.check = check;
    const onReveal = vi.fn();
    const view = render(
      <CitationContext.Provider value={{ ...env, onReveal }}>
        <CitationChip link={link} />
      </CitationContext.Provider>,
    );
    (view.container.querySelector("button.cite") as HTMLButtonElement).click();
    return onReveal;
  };

  it("hands the reason over with the page when the words were not found", () => {
    const onReveal = click({ status: "unlocated", page: 2 });
    expect(onReveal).toHaveBeenCalledTimes(1);
    const [page, rects, notice] = onReveal.mock.calls[0]!;
    expect(page).toBe(2);
    expect(rects).toBeNull();
    expect(notice).toContain("trust.unlocated.long");
  });

  it("lights the passage and says nothing more when the words were found", () => {
    const rects = [{ x: 1, y: 2, width: 3, height: 4 }];
    const onReveal = click({ status: "located", page: 2, rects });
    expect(onReveal).toHaveBeenCalledWith(2, rects, undefined);
  });
});
