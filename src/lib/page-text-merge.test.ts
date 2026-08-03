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

  it("keeps paid-for vision text against longer free text", () => {
    // Markdown extraction is routinely longer than a vision transcription of
    // the same page, so a length-only rule would spend a vision call and then
    // throw the result away.
    const vision = "v".repeat(40);
    const native = "n".repeat(400);
    expect(pickBetterPageText(vision, native, "vision", "native")).toBe(vision);
    expect(pickBetterPageText(native, vision, "native", "vision")).toBe(vision);
  });

  it("still compares length between two texts of the same origin", () => {
    const short = "n".repeat(40);
    const long = "n".repeat(400);
    expect(pickBetterPageText(short, long, "native", "native")).toBe(long);
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

  it("does not let a longer native re-extract overwrite vision text", () => {
    const vision = "v".repeat(40);
    const merged = mergePageTextsOnReload(
      [{ page: 1, text: vision, source: "vision" }],
      [{ page: 1, text: "n".repeat(4000), source: "native" }],
    );
    expect(merged[0]!.text).toBe(vision);
    // Provenance must survive the merge, or the next reload loses the page.
    expect(merged[0]!.source).toBe("vision");
  });

  it("preserves vision text for pages dropped from a shorter reload", () => {
    const vision = "v".repeat(40);
    const merged = mergePageTextsOnReload(
      [
        { page: 1, text: vision },
        { page: 2, text: "y".repeat(30) },
      ],
      [{ page: 1, text: "x" }],
    );
    expect(merged).toHaveLength(2);
    expect(merged.find((p) => p.page === 2)?.text).toBe("y".repeat(30));
  });
});
