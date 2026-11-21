import { afterEach, describe, expect, it } from "vitest";
import { buildDocumentMapInstructions } from "./agent-view-context";
import { claimBefore } from "./answer-tables";
import { claimSpanBefore } from "./citations";
import { docCache } from "./doc-cache";
import { searchDocumentPages } from "./document-search";
import { __resetMarkStoreForTests, addMark } from "./mark-store";
import { polarityMismatch } from "./polarity-check";
import { quantities, unstatedQuantities } from "./quantities";
import { locateQuote } from "./quote-locate";
import { rankPages } from "./ranked-search";

describe("v26 verification, search & document map upgrades", () => {
  afterEach(() => {
    docCache.clear();
    __resetMarkStoreForTests();
  });

  it("checks trailing claims after mid-sentence markers while keeping multi-marker sentences split", () => {
    const mid = 'According to Section 4〔p5 "Section 4"〕, the penalty rate is 2.5% per day.';
    expect(claimSpanBefore(mid, mid.indexOf("〔"))).toContain("2.5% per day");

    const dual = 'Deposit is 30%〔p2 "30%"〕 and balance is 70%〔p3 "70%"〕.';
    const firstIdx = dual.indexOf("〔p2");
    const secondIdx = dual.indexOf("〔p3");
    expect(claimSpanBefore(dual, firstIdx)).toBe("Deposit is 30%");
    expect(claimSpanBefore(dual, secondIdx)).toBe("and balance is 70%");
  });

  it("checks uncited row values when a table places citations in a dedicated Sources column", () => {
    const md = [
      "| # | Item | Rate | Source |",
      "| --- | --- | --- | --- |",
      '| 1 | Late fee | 25% | 〔p4 "Section 4"〕 |',
    ].join("\n");
    expect(claimBefore(md, md.indexOf("〔"))).toBe("Late fee · 25%");

    const inlineCell = [
      "| # | Quote |",
      "| --- | --- |",
      '| 1 | lorem〔p1 "Lorem ipsum"〕 |',
    ].join("\n");
    expect(claimBefore(inlineCell, inlineCell.indexOf("〔"))).toBe("lorem");
  });

  it("handles sub-month durations, basis points, spaced ranges, number words, and cross-format dates", () => {
    expect(unstatedQuantities("Notice within 72 hours", "Notice must be sent within 3 days.")).toEqual([]);
    expect(unstatedQuantities("Latency is 1.8 seconds", "Latency is 1.8 ms at p99.").map((q) => q.text)).toEqual([
      "1.8",
    ]);
    expect(unstatedQuantities("Fee is 1.5%", "Management fee is 150 bps per annum.")).toEqual([]);
    expect(unstatedQuantities("Minimum margin is 10%", "Operating margin ranged 10 –15%.")).toEqual([]);
    expect(
      unstatedQuantities("Cure period is 15 business days", "Cure within fifteen business days."),
    ).toEqual([]);
    expect(
      unstatedQuantities("Signed on 2025-04-17", "Executed on April 17, 2025 in Beijing."),
    ).toEqual([]);
    expect(
      unstatedQuantities("Signed on 2025年4月17日", "Executed on 17 April 2025."),
    ).toEqual([]);
    expect(
      unstatedQuantities("Signed on 2025-04-18", "Executed on April 17, 2025.").map((q) => q.text),
    ).toEqual(["2025-04-18"]);
    // Standalone pronoun `one` is never misread as quantity 1.
    expect(quantities("If one party breaches, notify the other party.")).toEqual([]);
  });

  it("rejects line transitions in locateQuote that skip unmatched words on the same line", () => {
    const items = [
      { text: "Revenue did", rect: { x: 72, y: 680, width: 68, height: 12 } },
      { text: "not", rect: { x: 144, y: 680, width: 20, height: 12 } },
      { text: "double.", rect: { x: 72, y: 664, width: 42, height: 12 } },
    ];
    expect(locateQuote(items, "Revenue did double.").status).toBe("absent");
    expect(locateQuote(items, "Revenue did not double.").status).toBe("located");
  });

  it("detects high-precision polarity flips without false alarms on conditionals or converse verbs", () => {
    expect(
      polarityMismatch("The deposit is refundable.", "The deposit is non-refundable."),
    ).not.toEqual([]);
    expect(
      polarityMismatch("Buyer receives the equipment.", "Seller shall deliver the equipment."),
    ).toEqual([]);
    expect(
      polarityMismatch(
        "Licensee may assign with prior written consent.",
        "Licensee shall not assign unless prior written consent is obtained.",
      ),
    ).toEqual([]);
  });

  it("matches CJK across spurious spaces and centers ranked snippets on stemmed surface words", () => {
    const hits = searchDocumentPages(
      [{ page: 2, text: "本合同由 临川市\n第二人民医院 与乙方签订。" }],
      "临川市第二人民医院",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.page).toBe(2);

    const filler = "Introductory background sentence repeated across the top of the page. ".repeat(6);
    const ranked = rankPages(
      [{ page: 3, text: `${filler}Clause 14 governs patent indemnities and defense costs.` }],
      "patent indemnity",
    );
    expect(ranked[0]?.snippet).toContain("indemnities");
  });

  it("builds a bounded <=1,200-char Turn-1 Document Map with outline, tables, figures, scans, and marks", () => {
    const path = "/docs/contract.pdf";
    docCache.set({
      path,
      name: "contract.pdf",
      kind: "pdf",
      totalPages: 5,
      pages: [
        { page: 1, text: "# Definitions\nBody" },
        { page: 2, text: "| Item | Price |\n| --- | --- |\n| A | 10 |" },
        { page: 3, text: "" },
        { page: 4, text: "" },
        { page: 5, text: "Signatures" },
      ],
      outline: Array.from({ length: 25 }, (_, i) => ({
        title: `Section ${i + 1}: Commercial Terms and Obligations`,
        page: (i % 5) + 1,
        level: i % 3 === 0 ? 1 : 2,
      })),
      figures: [{ page: 2, rect: { x: 10, y: 10, width: 100, height: 80 } }],
    });
    addMark(path, {
      page: 2,
      rects: [{ x: 10, y: 20, width: 120, height: 14 }],
      text: "Cap equals 100% of fees paid",
      note: "Verify cap exception",
      stamp: "s1",
    });

    const map = buildDocumentMapInstructions(path, 2);
    expect(map.length).toBeGreaterThan(50);
    expect(map.length).toBeLessThanOrEqual(1_200);
    expect(map).toContain("Outline:");
    expect(map).toContain("Tables on pp. 2");
    expect(map).toContain("Figures on pp. 2");
    expect(map).toContain("Unindexed/scan pp. 3–4");
    expect(map).toContain("Reader marks on p2:");
  });
});
