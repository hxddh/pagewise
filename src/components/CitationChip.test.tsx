// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** What the local check answers for the chip; each test sets it. */
const state = vi.hoisted(() => ({ check: null as unknown }));

vi.mock("../lib/citation-check", () => ({
  cachedCitationCheck: () => state.check,
  checkCitation: () => new Promise(() => {}),
  withClaim: (c: unknown) => c,
  subscribeChecks: () => () => {},
  checksEpoch: () => 0,
}));

vi.mock("../i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));

import { CitationChip, CitationContext, searchSeed, type CitationEnv } from "./CitationChip";

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

  // A red chip opens its popover instead since 24.0 (below); an amber chip
  // with nothing to light — a page with no readable text — still says why.
  it("hands the reason over with the page when there is nothing to light", () => {
    const onReveal = click({ status: "unreadable", page: 2 });
    expect(onReveal).toHaveBeenCalledTimes(1);
    const [page, rects, notice] = onReveal.mock.calls[0]!;
    expect(page).toBe(2);
    expect(rects).toBeNull();
    expect(notice).toContain("trust.unreadable.long");
  });

  it("lights the passage and says nothing more when the words were found", () => {
    const rects = [{ x: 1, y: 2, width: 3, height: 4 }];
    const onReveal = click({ status: "located", page: 2, rects });
    expect(onReveal).toHaveBeenCalledWith(2, rects, undefined);
  });
});

describe("a red chip explains itself where it is (24.0)", () => {
  // It used to show "3✗", say nothing on hover in the webview, turn to a page
  // with nothing lit, and explain itself in a toast at the far corner.
  const setup = (check: unknown, overrides: Partial<CitationEnv> = {}) => {
    state.check = check;
    const handlers = { onReveal: vi.fn(), onSearch: vi.fn(), onAsk: vi.fn() };
    const view = render(
      <CitationContext.Provider value={{ ...env, ...handlers, ...overrides }}>
        <CitationChip link={link} />
      </CitationContext.Provider>,
    );
    const chip = view.container.querySelector("button.cite") as HTMLButtonElement;
    return { ...handlers, view, chip };
  };
  const unlocated = { status: "unlocated", page: 2 };

  it("opens a popover with the quote and the verdict, and turns no page", () => {
    const { chip, onReveal } = setup(unlocated);
    expect(chip.getAttribute("aria-haspopup")).toBe("dialog");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("“a quoted passage”");
    expect(dialog.textContent).toContain("level.notFound");
    expect(dialog.textContent).toContain("trust.unlocated.long");
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(onReveal).not.toHaveBeenCalled();
  });

  it("opens from the keyboard: the chip is a button", () => {
    const { chip } = setup(unlocated);
    chip.focus();
    fireEvent.keyDown(chip, { key: "Enter" });
    // A native button turns Enter into a click; jsdom does not, so the click
    // is what the browser would send.
    fireEvent.click(chip);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("searches the document for the opening words of the quote", () => {
    const { chip, onSearch } = setup(unlocated);
    fireEvent.click(chip);
    fireEvent.click(screen.getByText("cite.popover.search"));
    expect(onSearch).toHaveBeenCalledWith("a quoted passage");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks the assistant to cite again through the composer", () => {
    const { chip, onAsk } = setup(unlocated);
    fireEvent.click(chip);
    fireEvent.click(screen.getByText("cite.popover.ask"));
    expect(onAsk).toHaveBeenCalledWith("cite.popover.askPrompt");
  });

  it("opens the page anyway, without a toast — the popover said why", () => {
    const { chip, onReveal } = setup(unlocated);
    fireEvent.click(chip);
    fireEvent.click(screen.getByText("cite.popover.open"));
    expect(onReveal).toHaveBeenCalledWith(2, null, undefined);
  });

  it("offers no page to open when the page does not exist", () => {
    const { chip } = setup({ status: "outOfRange", page: 9 });
    fireEvent.click(chip);
    expect(screen.queryByText("cite.popover.open")).toBeNull();
    expect(screen.getByText("cite.popover.search")).toBeTruthy();
  });

  it("closes on Escape", () => {
    const { chip } = setup(unlocated);
    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(chip.getAttribute("aria-expanded")).toBe("false");
  });

  it("leaves out the actions the panel cannot do", () => {
    const { chip } = setup(unlocated, { onSearch: undefined, onAsk: undefined });
    fireEvent.click(chip);
    expect(screen.queryByText("cite.popover.search")).toBeNull();
    expect(screen.queryByText("cite.popover.ask")).toBeNull();
    expect(screen.getByText("cite.popover.open")).toBeTruthy();
  });

  it("keeps a green chip as it was: one click lights the passage, no popover", () => {
    const rects = [{ x: 1, y: 2, width: 3, height: 4 }];
    const { chip, onReveal } = setup({ status: "located", page: 2, rects });
    expect(chip.getAttribute("aria-haspopup")).toBeNull();
    fireEvent.click(chip);
    expect(onReveal).toHaveBeenCalledWith(2, rects, undefined);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("searchSeed (24.0)", () => {
  it("takes the opening words of a spaced quote, without a trailing comma", () => {
    expect(searchSeed("Revenue rose, sharply in the third quarter")).toBe("Revenue rose, sharply in");
    expect(searchSeed("Revenue fell,  then  recovered")).toBe("Revenue fell, then recovered");
    expect(searchSeed("one two three, four")).toBe("one two three, four");
    expect(searchSeed("alpha beta gamma, delta epsilon")).toBe("alpha beta gamma, delta");
  });

  it("takes a dozen characters of an unspaced quote", () => {
    expect(searchSeed("营业收入同比增长百分之十二点五并创历史新高")).toBe("营业收入同比增长百分之十");
  });
});
