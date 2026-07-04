import { describe, expect, it } from "vitest";
import {
  extractExplicitPageNumbers,
  hasCurrentPageIntent,
  hasWholeDocumentIntent,
  isTargetedFactualQuery,
  shouldFollowAgentToPage,
} from "./page-intent";

const sorted = (nums: number[]): number[] => [...nums].sort((a, b) => a - b);

describe("extractExplicitPageNumbers", () => {
  it("parses ASCII 第N页", () => {
    expect(extractExplicitPageNumbers("请看第3页")).toEqual([3]);
  });

  it("parses Chinese numerals", () => {
    expect(extractExplicitPageNumbers("第五页")).toEqual([5]);
    expect(extractExplicitPageNumbers("第十页")).toEqual([10]);
    expect(extractExplicitPageNumbers("第十二页")).toEqual([12]);
    expect(extractExplicitPageNumbers("第二十三页")).toEqual([23]);
    expect(extractExplicitPageNumbers("第一百二十三页")).toEqual([123]);
  });

  it("parses full-width digits", () => {
    expect(extractExplicitPageNumbers("第５页")).toEqual([5]);
    expect(extractExplicitPageNumbers("第１２页")).toEqual([12]);
  });

  it("parses Chinese ranges (到 / 至)", () => {
    expect(sorted(extractExplicitPageNumbers("第3到5页"))).toEqual([3, 4, 5]);
    expect(sorted(extractExplicitPageNumbers("第二至四页"))).toEqual([2, 3, 4]);
  });

  it("parses English ranges", () => {
    expect(sorted(extractExplicitPageNumbers("see pages 3-5"))).toEqual([3, 4, 5]);
    expect(sorted(extractExplicitPageNumbers("pages 7 to 9"))).toEqual([7, 8, 9]);
  });

  it("parses English single page and abbreviations", () => {
    expect(extractExplicitPageNumbers("page 7")).toEqual([7]);
    expect(extractExplicitPageNumbers("pages 4")).toEqual([4]);
    expect(extractExplicitPageNumbers("see p. 12")).toEqual([12]);
    expect(extractExplicitPageNumbers("p 9 has it")).toEqual([9]);
  });

  it("dedupes across patterns", () => {
    expect(sorted(extractExplicitPageNumbers("第3页 and page 3"))).toEqual([3]);
  });

  it("returns empty when no page reference", () => {
    expect(extractExplicitPageNumbers("summarize this")).toEqual([]);
  });

  it("does not share regex lastIndex across calls", () => {
    expect(extractExplicitPageNumbers("page 2")).toEqual([2]);
    expect(extractExplicitPageNumbers("page 2")).toEqual([2]);
  });
});

describe("hasCurrentPageIntent", () => {
  it("matches Chinese variants", () => {
    expect(hasCurrentPageIntent("这一页讲了什么")).toBe(true);
    expect(hasCurrentPageIntent("当前页")).toBe(true);
    expect(hasCurrentPageIntent("本页")).toBe(true);
  });

  it("matches English variants", () => {
    expect(hasCurrentPageIntent("summarize this page")).toBe(true);
    expect(hasCurrentPageIntent("the current page please")).toBe(true);
  });

  it("is false otherwise", () => {
    expect(hasCurrentPageIntent("summarize the document")).toBe(false);
  });
});

describe("hasWholeDocumentIntent", () => {
  it("matches whole-document phrases", () => {
    expect(hasWholeDocumentIntent("全文总结")).toBe(true);
    expect(hasWholeDocumentIntent("entire document")).toBe(true);
    expect(hasWholeDocumentIntent("all pages")).toBe(true);
  });
});

describe("isTargetedFactualQuery", () => {
  it("matches targeted factual questions but not whole-document asks", () => {
    expect(isTargetedFactualQuery("文中有哪些日期？")).toBe(true);
    expect(isTargetedFactualQuery("list all names")).toBe(true);
    expect(isTargetedFactualQuery("总结整份文档")).toBe(false);
  });
});

describe("shouldFollowAgentToPage", () => {
  it("follows when no context", () => {
    expect(shouldFollowAgentToPage(3, null)).toBe(true);
  });

  it("does not follow for whole-document intent", () => {
    expect(
      shouldFollowAgentToPage(3, { userText: "总结全文", viewingPage: 1 }),
    ).toBe(false);
  });

  it("follows only the viewed page for current-page intent", () => {
    expect(
      shouldFollowAgentToPage(2, { userText: "这一页", viewingPage: 2 }),
    ).toBe(true);
    expect(
      shouldFollowAgentToPage(3, { userText: "这一页", viewingPage: 2 }),
    ).toBe(false);
  });

  it("does not follow when explicit page numbers were requested", () => {
    expect(
      shouldFollowAgentToPage(3, { userText: "第5页", viewingPage: 1 }),
    ).toBe(false);
  });

  it("follows the viewed page by default", () => {
    expect(
      shouldFollowAgentToPage(4, { userText: "explain more", viewingPage: 4 }),
    ).toBe(true);
    expect(
      shouldFollowAgentToPage(5, { userText: "explain more", viewingPage: 4 }),
    ).toBe(false);
  });
});
