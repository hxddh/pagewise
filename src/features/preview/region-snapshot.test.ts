import { describe, expect, it } from "vitest";
import { regionSnapshot } from "./region-snapshot";

describe("regionSnapshot", () => {
  it("keeps the words a region contains", () => {
    expect(regionSnapshot({ text: "  Total  revenue\n1,284 ", table: null })).toBe(
      "Total revenue 1,284",
    );
  });

  it("drops the extractor's image placeholder", () => {
    // Measured: a boxed figure on a scanned page comes back as "[Image: X4]".
    // Stored as-is the reader sees that in the sidebar as if it were the words
    // on the page.
    expect(regionSnapshot({ text: "[Image: X4]", table: null })).toBe("");
    expect(regionSnapshot({ text: "[Image: Im2]\n[Image: Im3]", table: null })).toBe("");
  });

  it("keeps the real words around a placeholder", () => {
    expect(regionSnapshot({ text: "Figure 3 [Image: Im2] shows growth", table: null })).toBe(
      "Figure 3 shows growth",
    );
  });

  it("prefers a table verbatim — reflowing it merges neighbouring numbers", () => {
    const table = "| Year | Revenue |\n|---|---|\n| 2024 | 16 |";
    expect(regionSnapshot({ text: "Year Revenue 2024 16", table })).toBe(table);
  });

  it("treats a region with nothing readable as empty rather than inventing text", () => {
    expect(regionSnapshot({ text: "   ", table: null })).toBe("");
    expect(regionSnapshot({ text: "", table: "  " })).toBe("");
  });

  it("truncates a very large region", () => {
    const snapshot = regionSnapshot({ text: "x".repeat(900), table: null });
    expect(snapshot).toHaveLength(501);
    expect(snapshot.endsWith("…")).toBe(true);
  });
});
