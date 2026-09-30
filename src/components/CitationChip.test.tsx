// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/citation-check", () => ({
  cachedCitationCheck: () => null,
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
});
