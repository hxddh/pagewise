import { describe, expect, it } from "vitest";
import { asksForEverything, unreadRelevantPages } from "./coverage";
import { followUpSuggestions } from "./follow-ups";

const pages = [
  { page: 1, text: "合同总价与付款方式。本合同价款分三期支付。" },
  { page: 2, text: "交付与验收。乙方应于合同生效之日起45日内交付。" },
  { page: 3, text: "质量保证。质保期为三十六个月。" },
  { page: 4, text: "违约责任。甲方逾期付款的，每逾期一日按万分之三支付违约金。" },
  { page: 5, text: "乙方逾期交货的，按千分之一支付违约金；违约金不足以弥补损失的，另行赔偿。" },
];

describe("unreadRelevantPages", () => {
  it("points at pages matching an exhaustive question that the answer did not read", () => {
    expect(unreadRelevantPages(pages, "列出合同中所有的违约金条款", [4])).toEqual([5]);
  });

  it("says nothing when everything matching was read", () => {
    expect(unreadRelevantPages(pages, "列出所有违约金条款", [4, 5])).toEqual([]);
  });

  it("says nothing for a question about one thing", () => {
    expect(unreadRelevantPages(pages, "质保期多久？", [3])).toEqual([]);
    expect(asksForEverything("What does page 3 say?")).toBe(false);
  });

  it("treats a table answer as a list, whatever the question", () => {
    expect(asksForEverything("违约金？", "| 条款 | 比例 |\n|---|---|\n| 逾期付款 | 万分之三 |")).toBe(true);
  });

  it("needs a reply that read something", () => {
    expect(unreadRelevantPages(pages, "列出所有违约金", [])).toEqual([]);
  });
});

describe("the follow-up", () => {
  it("comes first, and names the pages", () => {
    const t = (k: string, v?: Record<string, string | number>) => `${k}:${v?.pages ?? ""}`;
    const out = followUpSuggestions({
      readPages: [4],
      outline: [],
      totalPages: 5,
      unindexedCount: 0,
      markCount: 0,
      question: "列出所有违约金条款",
      pages,
      t,
    });
    expect(out[0]).toMatchObject({ kind: "unreadRelevant", pages: [5], text: "agent.followUpUnread:5" });
  });
});
