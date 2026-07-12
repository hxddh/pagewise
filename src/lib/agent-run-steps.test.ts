import { describe, expect, it } from "vitest";
import { resolveRunMaxSteps, compressPageRanges } from "./agent";

describe("resolveRunMaxSteps", () => {
  it("grants the default floor regardless of intent (no whole-doc gating)", () => {
    expect(resolveRunMaxSteps(0)).toBe(20);
    expect(resolveRunMaxSteps(3)).toBe(20);
    expect(resolveRunMaxSteps(200)).toBe(30);
  });

  it("scales with page count between the floor and ceiling", () => {
    expect(resolveRunMaxSteps(25)).toBe(25);
  });

  it("is bounded by the ceiling", () => {
    expect(resolveRunMaxSteps(500)).toBe(30);
  });
});

describe("compressPageRanges", () => {
  it("returns an empty string for no pages", () => {
    expect(compressPageRanges([])).toBe("");
  });

  it("renders a single page", () => {
    expect(compressPageRanges([7])).toBe("7");
  });

  it("collapses consecutive pages into a range", () => {
    expect(compressPageRanges([51, 52, 53])).toBe("51-53");
  });

  it("mixes ranges and singletons", () => {
    expect(compressPageRanges([51, 52, 53, 80, 95, 96])).toBe("51-53, 80, 95-96");
  });

  it("sorts and de-duplicates unordered input", () => {
    expect(compressPageRanges([53, 51, 52, 52])).toBe("51-53");
  });
});
