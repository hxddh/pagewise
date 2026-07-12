import { describe, expect, it } from "vitest";
import { resolveRunMaxSteps, resolveRunCharBudget, compressPageRanges } from "./agent";

describe("resolveRunMaxSteps", () => {
  it("uses the default cap for non-whole-document runs", () => {
    expect(resolveRunMaxSteps(false, 200)).toBe(15);
  });

  it("keeps at least the default for small whole-document runs", () => {
    expect(resolveRunMaxSteps(true, 3)).toBe(15);
    expect(resolveRunMaxSteps(true, 0)).toBe(15);
  });

  it("scales with page count for whole-document runs", () => {
    expect(resolveRunMaxSteps(true, 20)).toBe(20);
  });

  it("is bounded by the whole-document ceiling", () => {
    expect(resolveRunMaxSteps(true, 500)).toBe(30);
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

describe("resolveRunCharBudget", () => {
  it("uses the standard budget for targeted runs", () => {
    expect(resolveRunCharBudget(false)).toBe(120_000);
  });

  it("uses a larger budget for whole-document runs", () => {
    expect(resolveRunCharBudget(true)).toBe(200_000);
  });

  it("always grants whole-document runs at least the standard budget", () => {
    expect(resolveRunCharBudget(true)).toBeGreaterThanOrEqual(resolveRunCharBudget(false));
  });
});
