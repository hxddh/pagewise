import { describe, expect, it } from "vitest";
import { searchDocumentPages } from "./document-search";

describe("searchDocumentPages over markdown page text", () => {
  const pages = [
    {
      page: 1,
      text: "# 第三季度财务报告\n\n|项目|本期|上年同期|\n|---|---|---|\n|营业收入|1,284|1,141|",
    },
  ];

  it("matches a table cell that markdown syntax would otherwise hide", () => {
    const hits = searchDocumentPages(pages, "1,284");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.page).toBe(1);
  });

  it("quotes the row back without pipes", () => {
    const [hit] = searchDocumentPages(pages, "营业收入");
    expect(hit!.snippet).toContain("营业收入 1,284 1,141");
    expect(hit!.snippet).not.toContain("|");
  });

  it("finds a heading without its hash markers", () => {
    expect(searchDocumentPages(pages, "第三季度财务报告")).toHaveLength(1);
  });
});
