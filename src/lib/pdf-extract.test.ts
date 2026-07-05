import { describe, expect, it } from "vitest";
import { isPdfExtractCancelledError } from "./pdf";

describe("isPdfExtractCancelledError", () => {
  it("detects Rust cancel message", () => {
    expect(isPdfExtractCancelledError(new Error("PDF extract cancelled"))).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isPdfExtractCancelledError(new Error("PDF extract failed: io"))).toBe(false);
  });
});
