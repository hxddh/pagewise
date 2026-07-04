import { describe, expect, it } from "vitest";
import { formatSearchPreview } from "./search-preview";

describe("formatSearchPreview", () => {
  it("returns null for empty or invalid hits", () => {
    expect(formatSearchPreview(null)).toBeNull();
    expect(formatSearchPreview([])).toBeNull();
  });

  it("formats page snippets for progress preview", () => {
    const preview = formatSearchPreview([
      { page: 3, text: "Signed on January 12, 2024 in Shanghai" },
      { page: 7, snippet: "Effective date: March 1" },
    ]);
    expect(preview).toContain("2 page(s)");
    expect(preview).toContain("p.3:");
    expect(preview).toContain("p.7:");
  });
});
