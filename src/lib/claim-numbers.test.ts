import { beforeEach, describe, expect, it, vi } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { TextItemRect } from "./types";

let pages: Record<number, TextItemRect[]> = {};
vi.mock("./pdf", () => ({ pageTextItems: async (_p: string, page: number) => pages[page] ?? [] }));
vi.mock("./ocr/ocr-service", () => ({ ocrEnabled: () => false, ocrPage: async () => null }));

import { checkAnswer, clearCitationChecks, tallyCitations, verifiedSentences } from "./citation-check";
import { clearFindingAnchors, placeFinding } from "./finding-anchors";
import { trustOf } from "./finding-trust";
import { buildCitationFeedback } from "./agent-citation-context";
import { passageAround } from "./passage";
import { remarkCitations, parseCitationUrl } from "./remark-citations";

const PATH = "/docs/contract.pdf";
const run = (text: string, y: number, x = 72, width = 400): TextItemRect => ({ text, rect: { x, y, width, height: 12 } });

beforeEach(() => {
  pages = {
    3: [
      run("第六条 质量保证", 720),
      run("质保期为最终验收合格之日起三十六个月，", 700),
      run("质保期内乙方免费维修。", 686),
      // Another paragraph, further down: its number must not vouch for the first.
      run("第七条 违约责任", 600),
      run("乙方逾期交货的，每逾期一日按设备金额的千分之一支付违约金；逾期超过二十四个月的，甲方有权解除合同。", 586),
    ],
  };
  clearFindingAnchors();
  clearCitationChecks();
});

const QUOTE = '〔p3 "质保期为最终验收合格之日起三十六个月"〕';

describe("a number the passage does not state (15.0)", () => {
  it("is found, and doubted", async () => {
    const md = `质保期为 24 个月${QUOTE}。`;
    await checkAnswer(PATH, 10, md);
    expect(tallyCitations(PATH, md)).toMatchObject({ total: 1, located: 0, mismatch: 1 });
  });

  it("is not doubted in another spelling or unit", async () => {
    for (const md of [`质保期为 36 个月${QUOTE}。`, `质保期三年${QUOTE}。`, `The warranty runs 36 months${QUOTE}.`]) {
      await checkAnswer(PATH, 10, md);
      expect(tallyCitations(PATH, md), md).toMatchObject({ located: 1, mismatch: 0 });
    }
  });

  it("is not vouched for by a number elsewhere on the page", async () => {
    // 二十四个月 is on page 3 — in the next clause, not in the warranty's.
    const md = `质保期为二十四个月${QUOTE}。`;
    await checkAnswer(PATH, 10, md);
    expect(tallyCitations(PATH, md).mismatch).toBe(1);
  });

  it("is not kept as a verified sentence", async () => {
    const md = `质保期为 24 个月${QUOTE}。乙方免费维修〔p3 "质保期内乙方免费维修"〕。`;
    await checkAnswer(PATH, 10, md);
    expect(verifiedSentences(PATH, md).map((v) => v.claim)).toEqual(["乙方免费维修"]);
  });

  it("is named to the model on the next question", async () => {
    const md = `质保期为 24 个月${QUOTE}。`;
    await checkAnswer(PATH, 10, md);
    const note = buildCitationFeedback(PATH, [
      { role: "user", content: "质保期多久？" },
      { role: "assistant", content: md },
      { role: "user", content: "确定吗？" },
    ]);
    expect(note).toContain("24 in your sentence is not in that passage");
  });

  it("reads a table cell as the claim", async () => {
    const md = `| 条款 | 期限 |\n|---|---|\n| 质保 | 24 个月${QUOTE} |`;
    await checkAnswer(PATH, 10, md);
    expect(tallyCitations(PATH, md).mismatch).toBe(1);
  });
});

describe("passageAround", () => {
  it("is the paragraph the quote is in, not the page", () => {
    const items = pages[3]!;
    const passage = passageAround(items, [items[1]!.rect]);
    expect(passage).toContain("三十六个月");
    expect(passage).toContain("免费维修");
    expect(passage).not.toContain("二十四个月");
  });

  it("stays in its column", () => {
    const items = [run("left one", 700, 72, 200), run("right one", 700, 320, 200), run("left two", 686, 72, 200)];
    expect(passageAround(items, [items[0]!.rect])).toBe("left one left two");
  });
});

describe("remarkCitations", () => {
  it("carries each marker's claim, read from the answer's source", () => {
    const md = `质保期为 24 个月${QUOTE}。\n\n| 条款 | 期限 |\n|---|---|\n| 质保 | **36** 个月${QUOTE} |`;
    const processor = unified().use(remarkParse).use(remarkGfm).use(remarkCitations);
    const tree = processor.runSync(processor.parse(md), md) as unknown as { children: unknown[] };
    const urls: string[] = [];
    const walk = (n: { type?: string; url?: string; children?: unknown[] }) => {
      if (n.type === "link" && n.url) urls.push(n.url);
      (n.children ?? []).forEach((c) => walk(c as typeof n));
    };
    walk(tree as never);
    expect(urls.map((u) => parseCitationUrl(u)?.claim)).toEqual(["质保期为 24 个月", "36 个月"]);
  });
});

describe("a finding whose claim states a number its passage does not", () => {
  const finding = (claim: string) => ({
    id: "f1",
    pages: [3],
    claim,
    evidence: "质保期为最终验收合格之日起三十六个月",
    createdAt: 0,
    stamp: "s",
  });

  it("is placed, and doubted", async () => {
    const placement = await placeFinding(PATH, finding("质保期为 24 个月"));
    expect(placement).toMatchObject({ status: "mismatch", unstated: ["24"] });
    expect(trustOf(finding("质保期为 24 个月"), { stamp: "s", totalPages: 10, all: [], placement })).toBe("mismatch");
  });

  it("is located when the number matches in any spelling", async () => {
    clearFindingAnchors();
    expect((await placeFinding(PATH, finding("质保期为三年"))).status).toBe("located");
  });
});
