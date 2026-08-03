import { describe, expect, it } from "vitest";
import { markdownToPlainText } from "./markdown-text";

describe("markdownToPlainText", () => {
  it("flattens a table row so its cells stay separate words", () => {
    const md = "|项目|本期|上年同期|\n|---|---|---|\n|营业收入|1,284|1,141|";
    const plain = markdownToPlainText(md);

    expect(plain).toBe("项目 本期 上年同期\n营业收入 1,284 1,141");
    // The delimiter row carries no content and must not become a blank match.
    expect(plain).not.toContain("---");
    // The defect this whole change exists to prevent.
    expect(plain).not.toContain("1,2841,141");
  });

  it("drops heading, list and emphasis syntax", () => {
    expect(markdownToPlainText("## 1.2 Metrische Räume")).toBe("1.2 Metrische Räume");
    expect(markdownToPlainText("- first\n* second")).toBe("first\nsecond");
    expect(markdownToPlainText("a **bold** and *italic* word")).toBe(
      "a bold and italic word",
    );
    expect(markdownToPlainText("`code` and <u>underlined</u>")).toBe(
      "code and underlined",
    );
  });

  it("keeps link labels and discards their targets", () => {
    expect(markdownToPlainText("see [the spec](https://example.com/spec) now")).toBe(
      "see the spec now",
    );
  });

  it("leaves prose and bare punctuation untouched", () => {
    const prose = "Revenue rose 12.5% — see note (a), b*c, and 3 * 4.";
    expect(markdownToPlainText(prose)).toBe(prose);
  });
});
