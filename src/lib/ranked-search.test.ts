import { describe, expect, it } from "vitest";
import { rankPages, tokenize } from "./ranked-search";
import { searchForAgent } from "../document/search";

const pages = [
  { page: 1, text: "# Definitions\n\nThe buyer means the purchasing party." },
  { page: 2, text: "Payment is due in three instalments. Late payments accrue a penalty of 0.03% per day." },
  { page: 3, text: "## 违约责任\n\n乙方逾期交货的，每逾期一日按逾期交付设备金额的千分之一支付违约金。" },
  { page: 4, text: "Warranty: the seller repairs defects for thirty-six months after acceptance." },
];

describe("tokenize", () => {
  it("stems English inflections and drops stop words", () => {
    expect(tokenize("The payments are late")).toEqual(["payment", "late"]);
  });

  it("splits CJK into overlapping pairs and keeps other scripts whole", () => {
    expect(tokenize("违约金 HY-DR760")).toEqual(["违约", "约金", "hy", "dr760"]);
  });
});

describe("rankPages", () => {
  it("finds the page that has the query's words when no page has the phrase", () => {
    expect(rankPages(pages, "penalty for late payment")[0]?.page).toBe(2);
    expect(rankPages(pages, "延迟交货 违约")[0]?.page).toBe(3);
  });

  it("does not return a page that shares only one common word with a long query", () => {
    const hits = rankPages(pages, "warranty repairs defects months acceptance party");
    expect(hits.map((h) => h.page)).toEqual([4]);
  });

  it("gives a snippet around the words it matched", () => {
    expect(rankPages(pages, "late penalty")[0]?.snippet).toContain("penalty");
  });
});

describe("searchForAgent", () => {
  it("returns exact matches exactly as before, with nothing added", () => {
    expect(searchForAgent(pages, "three instalments")).toEqual([
      { page: 2, snippet: "Payment is due in three instalments. Late payments accrue a penalty of 0.03% per day." },
    ]);
  });

  it("falls back to ranked pages, marked as such, only when the phrase is nowhere", () => {
    const hits = searchForAgent(pages, "penalty late payment");
    expect(hits[0]).toMatchObject({ page: 2, match: "terms" });
  });
});
