import { describe, expect, it } from "vitest";
import { mergePageTextsOnReload, pickBetterPageText } from "./page-text-merge";

describe("pickBetterPageText", () => {
  it("keeps long indexed text over sparse re-extract", () => {
    const indexed = "x".repeat(25);
    expect(pickBetterPageText(indexed, "short")).toBe(indexed);
  });

  it("prefers incoming when it meets the index threshold", () => {
    const incoming = "y".repeat(30);
    expect(pickBetterPageText("tiny", incoming)).toBe(incoming);
  });
});

describe("mergePageTextsOnReload", () => {
  it("preserves vision text per page on reload", () => {
    const vision = "v".repeat(40);
    const merged = mergePageTextsOnReload(
      [{ page: 1, text: vision }],
      [{ page: 1, text: "x" }],
    );
    expect(merged[0]!.text).toBe(vision);
  });
});
