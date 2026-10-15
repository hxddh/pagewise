import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TextItemRect } from "./types";

/** What `page_text_items` answers per page: runs, or an empty page. */
let pages: Record<number, TextItemRect[]> = {};
vi.mock("./pdf", () => ({
  pageTextItems: async (_path: string, page: number) => pages[page] ?? [],
}));
vi.mock("./ocr/ocr-service", () => ({ ocrEnabled: () => false, ocrPage: async () => null }));
// The model review is the one billed call in this path; the stub answers
// "contradicts", so the test can watch it lower a sentence and nothing else.
vi.mock("ai", () => ({
  generateObject: async () => ({
    object: { verdict: "contradicts", reason: "原文说的不是这样" },
    usage: { inputTokens: 1, outputTokens: 1 },
  }),
}));
vi.mock("./settings", () => ({ loadSettings: async () => ({ provider: "openai", model: "m", apiKey: "k" }) }));
vi.mock("./llm", () => ({ resolveModel: () => "model", assertApiKeyForAgent: () => undefined }));

import {
  answerSentences,
  sentenceState,
  sentenceStates,
  sentenceTally,
  verifiedSentences,
  SENTENCE_STATES,
} from "./answer-sentences";
import { checkAnswer, clearCitationChecks } from "./citation-check";
import { cachedReview, clearReviews, reviewClaim } from "./claim-review";
import { clearFindingAnchors } from "./finding-anchors";
import { MIN_QUOTE_CHARS } from "./quote-locate";

const PATH = "/docs/contract.pdf";
const run = (text: string, y = 700): TextItemRect => ({ text, rect: { x: 72, y, width: 400, height: 12 } });
/** A quote long enough to check (>= MIN_QUOTE_CHARS), on the warranty page. */
const WARRANTY = '最终验收合格之日起三十六个月';
const WARRANTY_QUOTE = `〔p3 "${WARRANTY}"〕`;

beforeEach(() => {
  pages = {};
  clearFindingAnchors();
  clearCitationChecks();
  clearReviews();
});

describe("answerSentences", () => {
  it("splits prose into sentences, in both languages", () => {
    const md = "Revenue rose 12.5% last year. Costs stayed flat! 质保期为三十六个月。验收后付款？";
    expect(answerSentences(md).map((s) => s.text)).toEqual([
      "Revenue rose 12.5% last year.",
      "Costs stayed flat!",
      "质保期为三十六个月。",
      "验收后付款？",
    ]);
  });

  it("never splits inside a citation's quote", () => {
    // The quote carries a full stop of its own; the sentence ends after the marker.
    const md = 'The warranty runs three years〔p3 "质保期为三年。质保期内免费维修"〕.';
    const sentences = answerSentences(md);
    expect(sentences).toHaveLength(1);
    expect(sentences[0]!.citations).toHaveLength(1);
    expect(sentences[0]!.text).toBe("The warranty runs three years.");
  });

  it("never splits inside inline code or math, and leaves code fences and math blocks out", () => {
    const md = [
      "The value `3.5% of total` is fixed.",
      "",
      "```",
      "one. two. three.",
      "```",
      "",
      "$$",
      "a = b. c = d.",
      "$$",
      "",
      "Set $x. y$ to one.",
      "It costs $5. The other costs $10.",
    ].join("\n");
    expect(answerSentences(md).map((s) => s.text)).toEqual([
      "The value 3.5% of total is fixed.",
      "Set $x. y$ to one.",
      // A currency amount is not math: its period still ends a sentence.
      "It costs $5.",
      "The other costs $10.",
    ]);
  });

  it("reads a table row as one sentence, and its header as none", () => {
    const md = ["| Item | Amount |", "|---|---|", `| Deposit | 30%${WARRANTY_QUOTE} |`].join("\n");
    const sentences = answerSentences(md);
    expect(sentences).toHaveLength(1);
    expect(sentences[0]!.row).toBeTruthy();
    expect(sentences[0]!.text).toBe("Item: Deposit · Amount: 30%");
    expect(sentences[0]!.citations).toHaveLength(1);
  });

  it("counts a list item as a sentence and a heading as none", () => {
    const md = ["## What page two says", "", "- The first line states the name.", "- The second names the page."].join("\n");
    expect(answerSentences(md).map((s) => s.text)).toEqual([
      "The first line states the name.",
      "The second names the page.",
    ]);
  });

  it("gives a marker to the sentence that ends where it starts", () => {
    const md = `The deposit is 30%〔p2 "百分之三十的预付款"〕, the balance 70%〔p3 "百分之七十的尾款"〕.`;
    const [sentence] = answerSentences(md);
    expect(sentence!.citations.map((c) => c.pages[0])).toEqual([2, 3]);
  });
});

describe("sentenceStates", () => {
  it("counts sentences, not citations: a two-sentence, two-citation answer has two", async () => {
    pages[3] = [run("质保期为最终验收合格之日起三十六个月，质保期内乙方免费维修。")];
    const md = `质保期为 36 个月${WARRANTY_QUOTE}。质保期内免费维修〔p3 "质保期内乙方免费维修"〕。`;
    await checkAnswer(PATH, 10, md);
    const tally = sentenceTally(sentenceStates(PATH, md));
    expect(tally.total).toBe(2);
    expect(tally.verified).toBe(2);
  });

  it("gives every sentence of a settled answer one of the five states", async () => {
    pages[3] = [run("质保期为最终验收合格之日起三十六个月，质保期内乙方免费维修。")];
    const md = [
      "## Terms",
      "",
      `The warranty runs 36 months${WARRANTY_QUOTE}.`,
      "The supplier pays for repairs.",
      '- The deposit is 30%〔p3 "百分之三十的预付款"〕.',
      '- 质保期为 24 个月〔p3 "最终验收合格之日起三十六个月"〕.',
      "- See the annex〔p3〕.",
      "",
      "| Item | Amount |",
      "|---|---|",
      `| Warranty | 36 months${WARRANTY_QUOTE} |`,
      "",
      'Short quote〔p3 "month"〕.',
    ].join("\n");
    await checkAnswer(PATH, 10, md);
    const rows = sentenceStates(PATH, md);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(SENTENCE_STATES, row.sentence.text).toContain(row.state);
    }
    const byText = new Map(rows.map((r) => [r.sentence.text, r.state]));
    expect(byText.get("The warranty runs 36 months.")).toBe("verified");
    expect(byText.get("The supplier pays for repairs.")).toBe("unchecked");
    expect(byText.get("The deposit is 30%.")).toBe("notFound");
    expect(byText.get("质保期为 24 个月.")).toBe("check");
    expect(byText.get("See the annex.")).toBe("noQuote");
    expect(byText.get("Item: Warranty · Amount: 36 months")).toBe("verified");
    expect(byText.get("Short quote.")).toBe("noQuote");
  });

  it("never invents a verification for a sentence with no marker", async () => {
    pages[3] = [run("质保期为最终验收合格之日起三十六个月。")];
    const md = `质保期为 36 个月${WARRANTY_QUOTE}。乙方负责维修，费用另计。`;
    await checkAnswer(PATH, 10, md);
    const rows = sentenceStates(PATH, md);
    const unmarked = rows.find((r) => r.sentence.text.startsWith("乙方负责维修"))!;
    expect(unmarked.state).toBe("unchecked");
    expect(unmarked.reason).toBe("noMarker");
    expect(verifiedSentences(PATH, md).map((v) => v.claim)).toEqual(["质保期为 36 个月"]);
  });

  it("assigns local evidence to an uncited sentence: the numbers its answer already cites", async () => {
    pages[3] = [run("质保期为最终验收合格之日起三十六个月，质保期内乙方免费维修。")];
    const md = [
      `质保期为 36 个月${WARRANTY_QUOTE}。`,
      "质保期仍为 36 个月。",
      "逾期付款按日万分之三计息。",
      "乙方负责维修。",
    ].join("\n");
    await checkAnswer(PATH, 10, md);
    const rows = sentenceStates(PATH, md);
    const evidence = (text: string) => rows.find((r) => r.sentence.text === text)!.numbersInEvidence;
    // 36 个月 is in the passage the answer's own citation was found in.
    expect(evidence("质保期仍为 36 个月。")).toBe(true);
    // 万分之三 is nowhere in the cited text; 乙方负责维修 states no numbers.
    expect(evidence("逾期付款按日万分之三计息。")).toBe(false);
    expect(evidence("乙方负责维修。")).toBe(false);
    // Evidence about the numbers is not a check of the sentence: still unchecked.
    for (const text of ["质保期仍为 36 个月。", "逾期付款按日万分之三计息。", "乙方负责维修。"]) {
      expect(rows.find((r) => r.sentence.text === text)!.state).toBe("unchecked");
    }
  });

  it("shows a quote too short to check as tooShort, at the MIN_QUOTE_CHARS boundary", async () => {
    pages[3] = [run("Revenue fell sharply.")];
    const short = "fell";
    const long = "Revenue fell sharply";
    expect(short.length).toBeLessThan(MIN_QUOTE_CHARS);
    expect(long.length).toBeGreaterThanOrEqual(MIN_QUOTE_CHARS);
    const md = `Revenue ${short}〔p3 "${short}"〕. ${long}〔p3 "${long}"〕.`;
    await checkAnswer(PATH, 10, md);
    const rows = sentenceStates(PATH, md);
    const tooShort = rows.find((r) => r.reason === "tooShort")!;
    expect(tooShort.state).toBe("noQuote");
    expect(rows.find((r) => r.reason === "located")!.state).toBe("verified");
  });

  it("reads the worst marker of a sentence, so no chip's failure is hidden", async () => {
    pages[3] = [run("The deposit is thirty percent of the total.")];
    const md = 'The deposit is 30%〔p3 "thirty percent of the total"〕, the balance 70%〔p3 "seventy percent"〕.';
    await checkAnswer(PATH, 10, md);
    const [row] = sentenceStates(PATH, md);
    expect(row!.state).toBe("notFound");
    expect(verifiedSentences(PATH, md)).toEqual([]);
  });

  it("counts a sentence whose checks are still running as pending", () => {
    const md = `质保期为 36 个月${WARRANTY_QUOTE}。乙方负责维修。`;
    const rows = sentenceStates(PATH, md);
    expect(sentenceTally(rows)).toMatchObject({ total: 2, pending: 1, unchecked: 1 });
  });
});

describe("sentenceState (the rule, for a caller with its own checks)", () => {
  it("takes the worst level, and pending only while nothing is settled", () => {
    expect(sentenceState(["verified"])).toBe("verified");
    expect(sentenceState(["verified", "none"])).toBe("verified");
    expect(sentenceState(["verified", "check"])).toBe("check");
    expect(sentenceState(["check", "notFound"])).toBe("notFound");
    expect(sentenceState(["none"])).toBe("noQuote");
    expect(sentenceState(["none"], true)).toBe("pending");
    expect(sentenceState(["verified"], true)).toBe("verified");
  });
});

describe("keep-verified agrees with the sentence states (20.0)", () => {
  it("keeps exactly the sentences the table counts as verified", async () => {
    pages[3] = [
      run("质保期为最终验收合格之日起三十六个月，质保期内乙方免费维修。"),
      run("甲方应在合同生效后十个工作日内预付合同总价的百分之三十"),
    ];
    const md = [
      `质保期为 36 个月${WARRANTY_QUOTE}。`,
      "乙方负责维修，费用另计。",
      '- 质保期为 24 个月〔p3 "最终验收合格之日起三十六个月"〕.',
      'The deposit is 30%〔p3 "预付合同总价的百分之三十"〕, the balance 70%〔p3 "到货验收合格后支付百分之六十"〕.',
      "",
      "| Item | Amount |",
      "|---|---|",
      '| Deposit | 30%〔p3 "预付合同总价的百分之三十"〕 |',
      '| Balance | 70%〔p3 "到货验收合格后支付百分之六十"〕 |',
    ].join("\n");
    await checkAnswer(PATH, 10, md);
    const verified = sentenceStates(PATH, md).filter((r) => r.state === "verified");
    const kept = verifiedSentences(PATH, md);
    // Every kept entry's claim comes from a sentence the table counted as
    // verified, and every verified sentence with a quoted marker contributed.
    const texts = new Set(verified.map((r) => r.sentence.text));
    expect(texts).toEqual(new Set(["质保期为 36 个月。", "Item: Deposit · Amount: 30%"]));
    expect(kept.map((k) => k.claim).sort()).toEqual(["Item: Deposit · Amount: 30%", "质保期为 36 个月"].sort());
    // The mixed row is not verified, so it is not kept — a row is only as
    // verified as its least-verified cell.
    expect(kept.some((k) => k.claim.includes("Balance"))).toBe(false);
    // The mismatch sentence is doubted, not verified.
    expect(kept.some((k) => k.claim.includes("24"))).toBe(false);
  });

  it("stops counting a sentence as verified when the reader's model contradicts it", async () => {
    pages[3] = [run("质保期为最终验收合格之日起三十六个月。")];
    const md = `质保期为 36 个月${WARRANTY_QUOTE}。`;
    await checkAnswer(PATH, 10, md);
    expect(sentenceStates(PATH, md)[0]!.state).toBe("verified");
    // The review can only lower a level, never raise one (16.0) — and it is
    // the same lowering the chip shows beside the local verdict.
    await reviewClaim(PATH, "质保期为 36 个月", WARRANTY, "质保期为最终验收合格之日起三十六个月。", 3);
    expect(cachedReview(PATH, "质保期为 36 个月", WARRANTY)?.verdict).toBe("contradicts");
    expect(sentenceStates(PATH, md)[0]!.state).toBe("notFound");
    expect(verifiedSentences(PATH, md)).toEqual([]);
  });
});
