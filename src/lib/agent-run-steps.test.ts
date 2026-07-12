import { describe, expect, it } from "vitest";
import { resolveRunMaxSteps } from "./agent";

describe("resolveRunMaxSteps", () => {
  it("uses the default cap for non-whole-document runs", () => {
    expect(resolveRunMaxSteps(false, 200)).toBe(12);
  });

  it("keeps at least the default for small whole-document runs", () => {
    expect(resolveRunMaxSteps(true, 3)).toBe(12);
    expect(resolveRunMaxSteps(true, 0)).toBe(12);
  });

  it("scales with page count for whole-document runs", () => {
    expect(resolveRunMaxSteps(true, 20)).toBe(20);
  });

  it("is bounded by the whole-document ceiling", () => {
    expect(resolveRunMaxSteps(true, 500)).toBe(30);
  });
});
