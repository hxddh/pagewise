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
    expect(preview?.pages).toBe(2);
    expect(preview?.message).toContain("2 page(s)");
    expect(preview?.snippets).toContain("p.3:");
    expect(preview?.snippets).toContain("p.7:");
  });

  it("counts distinct pages, not raw hits", () => {
    const preview = formatSearchPreview([
      { page: 5, snippet: "first match" },
      { page: 5, snippet: "second match" },
      { page: 5, snippet: "third match" },
    ]);
    expect(preview?.pages).toBe(1);
    expect(preview?.message).toContain("1 page(s)");
  });
});
