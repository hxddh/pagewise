/**
 * Adversarial Entailment 2.0 benchmark (26.0): does deterministic citation
 * verification catch claims that quote real words from the page while lying
 * about what those words say?
 *
 * Six adversarial categories, each paired with an honest control on the same
 * page runs so precision (zero false alarms on honest paraphrases) and recall
 * (catching adversarial distortions) are gated together:
 *   1. Polarity / modal flip ("may terminate" vs "shall not terminate", "不可退还" vs "可退还")
 *   2. Comparator / bound flip ("at least 30%" vs "no more than 30%", "不超过30日" vs "不少于30日")
 *   3. Deadline / trend direction flip ("within 30 days" vs "after 30 days", "增长 12%" vs "下降 12%")
 *   4. Mid-sentence & table-Source-column unstated numbers (closing the pre-marker scope gap)
 *   5. Table row bleed & repeated-quote disambiguation (neighboring row's $ figure vs own row's)
 *   6. Party obligation swap & cross-format date/unit distortion ("乙方支付" vs "甲方支付", "1.8 ms" vs "1.8 s", "2025-04-18" vs "April 17, 2025")
 */
import { describe, expect, it } from "vitest";
import { claimBefore } from "../src/lib/answer-tables";
import { extractCitations } from "../src/lib/citations";
import { withClaim, type CitationCheck } from "../src/lib/citation-check";
import { passageAround } from "../src/lib/passage";
import { locateQuote, locateQuoteAll } from "../src/lib/quote-locate";
import type { TextItemRect } from "../src/lib/types";

function run(text: string, x: number, y: number, width = 420, height = 12): TextItemRect {
  return { text, rect: { x, y, width, height } };
}

function checkMarkdownAgainstRuns(markdown: string, pageRunsMap: Record<number, TextItemRect[]>) {
  const cites = extractCitations(markdown);
  return cites.map((c) => {
    const page = c.pages[0]!;
    const items = pageRunsMap[page] ?? [];
    const quote = c.quote ?? "";
    const outcome = locateQuote(items, quote);
    if (outcome.status !== "located") {
      return { status: outcome.status };
    }
    const all = locateQuoteAll(items, quote);
    const candidates = all.map((m) => ({
      rects: m.rects,
      passage: passageAround(items, m.rects),
    }));
    const base: CitationCheck = {
      status: "located",
      page,
      rects: outcome.rects,
      passage: candidates[0]?.passage ?? passageAround(items, outcome.rects),
      ...(candidates.length > 1 ? { candidates } : {}),
    };
    const claim = claimBefore(markdown, c.index);
    return withClaim(base, claim, quote)!;
  });
}

interface AdversarialCase {
  category: string;
  name: string;
  runs: Record<number, TextItemRect[]>;
  honest: string;
  adversarial: string;
}

const CASES: readonly AdversarialCase[] = [
  // 1. Polarity / modal flips
  {
    category: "polarity",
    name: "non-refundable vs refundable deposit (EN)",
    runs: {
      2: [run("Section 3.2: The upfront reservation deposit is strictly non-refundable upon cancellation.", 72, 680)],
    },
    honest: 'The upfront deposit is non-refundable if cancelled〔p2 "upfront reservation deposit is strictly non-refundable"〕.',
    adversarial: 'The upfront deposit is refundable if cancelled〔p2 "upfront reservation deposit"〕.',
  },
  {
    category: "polarity",
    name: "不得转包 vs 可以转包 (ZH)",
    runs: {
      4: [run("第七条 乙方不得转包本合同项下的核心研发工作。", 72, 640)],
    },
    honest: '乙方不得转包核心研发工作〔p4 "乙方不得转包本合同项下的核心研发工作"〕。',
    adversarial: '乙方可以转包核心研发工作〔p4 "本合同项下的核心研发工作"〕。',
  },
  {
    category: "polarity",
    name: "shall not assign vs may assign (EN)",
    runs: {
      5: [run("Clause 9: Licensee shall not assign this Agreement to any affiliate.", 72, 600)],
    },
    honest: 'Licensee shall not assign the agreement〔p5 "Licensee shall not assign this Agreement"〕.',
    adversarial: 'Licensee may assign the agreement〔p5 "assign this Agreement to any affiliate"〕.',
  },

  // 2. Comparator / bound flips
  {
    category: "comparator",
    name: "at least 30% vs no more than 30%",
    runs: {
      3: [run("The minimum down payment shall be at least 30% of the contract value.", 72, 660)],
    },
    honest: 'Down payment is at least 30% of contract value〔p3 "down payment shall be at least 30%"〕.',
    adversarial: 'Down payment is capped at no more than 30% of contract value〔p3 "30% of the contract value"〕.',
  },
  {
    category: "comparator",
    name: "不超过 15 日 vs 不少于 15 日 (ZH)",
    runs: {
      6: [run("整改期限最长不超过15日，逾期甲方有权解除合同。", 72, 620)],
    },
    honest: '整改期限不超过 15 日〔p6 "整改期限最长不超过15日"〕。',
    adversarial: '整改期限不少于 15 日〔p6 "整改期限最长不超过15日"〕。',
  },

  // 3. Deadline & trend direction flips
  {
    category: "direction",
    name: "within 30 days vs after 30 days",
    runs: {
      2: [run("Notice of defect must be delivered within 30 days of receipt.", 72, 680)],
    },
    honest: 'Defect notice is due within 30 days of receipt〔p2 "delivered within 30 days of receipt"〕.',
    adversarial: 'Defect notice may only be delivered after 30 days of receipt〔p2 "30 days of receipt"〕.',
  },
  {
    category: "direction",
    name: "operating margin decreased vs increased by 4.5%",
    runs: {
      8: [run("In Q3, operating margin decreased by 4.5% due to supply constraints.", 72, 540)],
    },
    honest: 'Operating margin decreased by 4.5% in Q3〔p8 "operating margin decreased by 4.5%"〕.',
    adversarial: 'Operating margin increased by 4.5% in Q3〔p8 "4.5% due to supply constraints"〕.',
  },

  // 4. Mid-sentence & table Source-column scope escapes
  {
    category: "scope",
    name: "mid-sentence marker followed by fabricated trailing rate",
    runs: {
      5: [run("Section 4.1 governs late payment interest at 0.03% per day.", 72, 640)],
    },
    honest: 'According to Section 4.1〔p5 "Section 4.1 governs late payment"〕, interest accrues at 0.03% per day.',
    adversarial: 'According to Section 4.1〔p5 "Section 4.1 governs late payment"〕, interest accrues at 2.5% per day.',
  },
  {
    category: "scope",
    name: "dedicated Sources column at end of Markdown table row",
    runs: {
      3: [run("Warranty period: 36 months from final acceptance.", 72, 640)],
    },
    honest: [
      "| Term | Duration | Source |",
      "| --- | --- | --- |",
      '| Warranty | 36 months | 〔p3 "Warranty period: 36 months"〕 |',
    ].join("\n"),
    adversarial: [
      "| Term | Duration | Source |",
      "| --- | --- | --- |",
      '| Warranty | 12 months | 〔p3 "Warranty period: 36 months"〕 |',
    ].join("\n"),
  },

  // 5. Table row bleed & repeated-quote disambiguation
  {
    category: "tableRow",
    name: "multi-row table prevents neighboring row figure from validating wrong row",
    runs: {
      1: [
        run("Tier Basic", 72, 680, 90, 12),
        run("$5,000", 220, 680, 70, 12),
        run("30 days", 340, 680, 70, 12),
        run("Tier Enterprise", 72, 662, 110, 12),
        run("$50,000", 220, 662, 80, 12),
        run("90 days", 340, 662, 70, 12),
      ],
    },
    honest: 'Tier Basic costs $5,000 with 30 days support〔p1 "Tier Basic"〕.',
    adversarial: 'Tier Basic costs $50,000 with 90 days support〔p1 "Tier Basic"〕.',
  },
  {
    category: "tableRow",
    name: "repeated quote on same page disambiguates to matching clause",
    runs: {
      4: [
        run("Clause A: Initial filing fee is $5,000 payable within 10 days.", 72, 700),
        run("Clause B: Renewal fee is $5,000 payable within 45 days.", 72, 520),
      ],
    },
    honest: 'The renewal fee of $5,000 is payable within 45 days〔p4 "is $5,000 payable"〕.',
    adversarial: 'The renewal fee of $5,000 is payable within 90 days〔p4 "is $5,000 payable"〕.',
  },

  // 6. Party swap & cross-format unit/date precision
  {
    category: "partyAndUnits",
    name: "sole-party obligation swap (乙方支付 vs 甲方支付)",
    runs: {
      6: [run("违约责任：乙方应承担全部检测及返工费用。", 72, 600)],
    },
    honest: '乙方承担全部检测及返工费用〔p6 "乙方应承担全部检测及返工费用"〕。',
    adversarial: '甲方承担全部检测及返工费用〔p6 "全部检测及返工费用"〕。',
  },
  {
    category: "partyAndUnits",
    name: "milliseconds vs seconds & bps vs percent & ISO vs English date",
    runs: {
      9: [
        run("P99 latency is 1.8 ms under a 150 bps fee schedule signed April 17, 2025.", 72, 640),
      ],
    },
    honest:
      'Signed on 2025-04-17, the fee is 1.5% and P99 latency is 1.8 ms〔p9 "P99 latency is 1.8 ms"〕.',
    adversarial:
      'Signed on 2025-04-18, the fee is 1.5% and P99 latency is 1.8 seconds〔p9 "P99 latency is 1.8 ms"〕.',
  },
];

describe("Entailment 2.0 adversarial verification suite (v26)", () => {
  it("passes 100% of honest paraphrases and flags 100% of adversarial distortions", () => {
    const falseAlarms: string[] = [];
    const missedAdversarial: string[] = [];

    for (const tc of CASES) {
      const honestResults = checkMarkdownAgainstRuns(tc.honest, tc.runs);
      if (honestResults.some((r) => r.status !== "located")) {
        falseAlarms.push(`${tc.category}/${tc.name}: ${JSON.stringify(honestResults)}`);
      }
      const advResults = checkMarkdownAgainstRuns(tc.adversarial, tc.runs);
      if (!advResults.some((r) => r.status === "mismatch")) {
        missedAdversarial.push(`${tc.category}/${tc.name}: ${JSON.stringify(advResults)}`);
      }
    }

    expect(falseAlarms).toEqual([]);
    expect(missedAdversarial).toEqual([]);
  });
});
