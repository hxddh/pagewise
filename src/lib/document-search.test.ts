import { describe, expect, it } from "vitest";
import type { PageText } from "./types";
import { countSearchHits, searchDocumentPages } from "./document-search";

const pages = (...texts: string[]): PageText[] =>
  texts.map((text, i) => ({ page: i + 1, text }));

describe("searchDocumentPages", () => {
  it("returns empty for a blank query", () => {
    expect(searchDocumentPages(pages("hello world"), "  ")).toEqual([]);
  });

  it("finds case-insensitive matches with correct page/index", () => {
    const hits = searchDocumentPages(pages("The Quick brown FOX"), "fox");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ page: 1, index: 16, match: "FOX" });
  });

  it("finds multiple matches on a page", () => {
    const hits = searchDocumentPages(pages("aa aa aa"), "aa");
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.index)).toEqual([0, 3, 6]);
  });

  it("respects the limit", () => {
    const hits = searchDocumentPages(pages("x x x x x x x x"), "x", 3);
    expect(hits).toHaveLength(3);
  });

  it("keeps snippet indices aligned across capital dotted I (length-changing lowercase)", () => {
    // "İ".toLowerCase() expands to two UTF-16 units; without an index map the
    // slice would be shifted by one.
    const text = "İstanbul"; // İstanbul
    const hits = searchDocumentPages(pages(text), "stanbul");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.index).toBe(1);
    expect(hits[0]!.match).toBe("stanbul");
  });

  it("matches across NFC/NFD normalization forms", () => {
    const composed = "caf\u00e9"; // café with precomposed é (U+00E9)
    const decomposed = "cafe\u0301"; // café with combining acute accent (U+0301)
    expect(composed).not.toBe(decomposed);
    // Query composed, text decomposed
    expect(searchDocumentPages(pages(decomposed), composed)).toHaveLength(1);
    // Query decomposed, text composed
    expect(searchDocumentPages(pages(composed), decomposed)).toHaveLength(1);
  });

  it("produces an ellipsis prefix when the snippet does not start at 0", () => {
    const text = "0123456789".repeat(20) + "needle tail";
    const hits = searchDocumentPages(pages(text), "needle");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet.startsWith("…")).toBe(true);
  });

  it("has no ellipsis prefix when the match is near the start", () => {
    const hits = searchDocumentPages(pages("needle at the front"), "needle");
    expect(hits[0]!.snippet.startsWith("…")).toBe(false);
  });

  it("supports CJK search", () => {
    const hits = searchDocumentPages(pages("这是一个测试文档，测试搜索功能"), "测试");
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ page: 1, match: "测试" });
  });

  it("searches across multiple pages", () => {
    const hits = searchDocumentPages(pages("alpha", "beta target", "target again"), "target");
    expect(hits.map((h) => h.page)).toEqual([2, 3]);
  });
});

describe("countSearchHits", () => {
  it("counts all hits regardless of the default limit", () => {
    expect(countSearchHits(pages("a a a a a"), "a")).toBe(5);
  });

  it("counts zero when absent", () => {
    expect(countSearchHits(pages("nothing here"), "zzz")).toBe(0);
  });
});
