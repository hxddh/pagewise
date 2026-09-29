import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TextItemRect } from "./types";

let pages: Record<number, TextItemRect[]> = {};
vi.mock("./pdf", () => ({ pageTextItems: async (_p: string, page: number) => pages[page] ?? [] }));
vi.mock("./ocr/ocr-service", () => ({ ocrEnabled: () => false, ocrPage: async () => null }));

import { answerTables, rowClaim, tablesToCsv, type CsvLabels } from "./answer-tables";
import { checkAnswer, clearCitationChecks, verifiedSentences } from "./citation-check";
import { clearFindingAnchors } from "./finding-anchors";

const PATH = "/docs/contract.pdf";
const run = (text: string, y = 700): TextItemRect => ({ text, rect: { x: 72, y, width: 400, height: 12 } });

const ANSWER = [
  "The contract sets three payments:",
  "",
  "| Payment | Amount | When |",
  "|---|---|---|",
  '| Deposit | 30%〔p3 "预付合同总价的百分之三十"〕 | On signing〔p3 "合同生效后十个工作日内"〕 |',
  '| Delivery | 60%〔p3 "到货验收合格后支付百分之六十"〕 | After acceptance |',
  '| Warranty \\| retention | 10%〔p4 "质保金为百分之十"〕 | — |',
  "",
  "Anything else is in the annexes.",
].join("\n");

const labels: CsvLabels = {
  sources: "Sources",
  checked: "Checked",
  status: {
    located: "found",
    unlocated: "not found",
    unreadable: "unreadable",
    unconfirmed: "unconfirmed",
    unchecked: "not checked",
    outOfRange: "no such page",
    pending: "pending",
  },
  found: (a, b) => `${a} of ${b} found`,
  none: "no quote",
};

beforeEach(() => {
  pages = {};
  clearFindingAnchors();
  clearCitationChecks();
});

describe("answerTables", () => {
  it("reads headers and rows, keeping markers and escaped pipes inside their cells", () => {
    const [t] = answerTables(ANSWER);
    expect(t!.headers).toEqual(["Payment", "Amount", "When"]);
    expect(t!.rows).toHaveLength(3);
    expect(t!.rows[0]!.cells[1]).toContain("〔p3");
    expect(t!.rows[2]!.cells[0]).toBe("Warranty | retention");
  });

  it("does not split a cell on a pipe inside a quote", () => {
    const [t] = answerTables('| A | B |\n|---|---|\n| x〔p1 "a | b"〕 | y |');
    expect(t!.rows[0]!.cells).toEqual(['x〔p1 "a | b"〕', "y"]);
  });

  it("finds nothing in prose", () => {
    expect(answerTables("No table | here.\nJust text.")).toEqual([]);
  });

  it("makes a row one line of claim, without markers or placeholders", () => {
    const [t] = answerTables(ANSWER);
    expect(rowClaim(t!, t!.rows[0]!)).toBe("Payment: Deposit · Amount: 30% · When: On signing");
    expect(rowClaim(t!, t!.rows[2]!)).toBe("Payment: Warranty | retention · Amount: 10%");
  });
});

describe("tables leave as CSV with their evidence", () => {
  it("adds the pages each row cites and what was found there", async () => {
    pages[3] = [run("甲方应在合同生效后十个工作日内预付合同总价的百分之三十")];
    pages[4] = [run("本合同质保期为二十四个月")];
    await checkAnswer(PATH, 10, ANSWER);
    const csv = tablesToCsv(PATH, ANSWER, labels);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).trim().split("\r\n");
    expect(lines[0]).toBe("Payment,Amount,When,Sources,Checked");
    expect(lines[1]).toBe("Deposit,30%,On signing,p. 3 found; p. 3 found,2 of 2 found");
    expect(lines[2]).toBe("Delivery,60%,After acceptance,p. 3 not found,0 of 1 found");
    expect(lines[3]).toBe("Warranty | retention,10%,—,p. 4 not found,0 of 1 found");
  });

  it("quotes fields a spreadsheet would split", () => {
    const csv = tablesToCsv(PATH, '| A |\n|---|\n| 1,000, "net" |', labels);
    expect(csv).toContain('"1,000, ""net"""');
  });
});

describe("keeping verified rows", () => {
  it("keeps a table row as its row, not the cells before the marker", async () => {
    pages[3] = [run("甲方应在合同生效后十个工作日内预付合同总价的百分之三十")];
    await checkAnswer(PATH, 10, ANSWER);
    const kept = verifiedSentences(PATH, ANSWER);
    expect(kept.map((k) => k.claim)).toEqual(["Payment: Deposit · Amount: 30% · When: On signing"]);
  });

  it("does not keep a row in which any quote was not found", async () => {
    // Only the deposit amount is on page 3; its "when" is not.
    pages[3] = [run("预付合同总价的百分之三十")];
    await checkAnswer(PATH, 10, ANSWER);
    expect(verifiedSentences(PATH, ANSWER)).toEqual([]);
  });
});
