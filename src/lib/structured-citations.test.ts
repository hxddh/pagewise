import { describe, expect, it } from "vitest";
import {
  formatStructuredCitationsForDisplay,
  normalizeStructuredCitations,
} from "./structured-citations";

describe("normalizeStructuredCitations", () => {
  it("dedupes and sorts inverted page ranges", () => {
    const out = normalizeStructuredCitations(
      [
        { page: 5, pageEnd: 3, quote: "alpha" },
        { page: 3, quote: "beta" },
        { page: 3, quote: "dup" },
      ],
      10,
    );
    expect(out).toHaveLength(2);
    expect(out).toContainEqual({ page: 3, quote: "beta" });
    expect(out).toContainEqual({ page: 3, pageEnd: 5, quote: "alpha" });
  });

  it("drops pages outside document bounds", () => {
    const out = normalizeStructuredCitations(
      [
        { page: 0, quote: "bad" },
        { page: 2, quote: "ok" },
        { page: 9, quote: "too far" },
      ],
      5,
    );
    expect(out).toEqual([{ page: 2, quote: "ok" }]);
  });
});

describe("formatStructuredCitationsForDisplay", () => {
  it("formats single pages and ranges", () => {
    const text = formatStructuredCitationsForDisplay([
      { page: 2, quote: "hello" },
      { page: 4, pageEnd: 6, quote: "range" },
    ]);
    expect(text).toContain("[p.2] hello");
    expect(text).toContain("[p.4–6] range");
  });
});
