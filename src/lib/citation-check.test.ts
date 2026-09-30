import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TextItemRect } from "./types";

/** What `page_text_items` answers per page: runs, an empty page, or an error. */
let pages: Record<number, TextItemRect[] | Error> = {};
let reads = 0;
vi.mock("./pdf", () => ({
  pageTextItems: async (_path: string, page: number) => {
    reads += 1;
    const answer = pages[page];
    if (answer instanceof Error) throw answer;
    return answer ?? [];
  },
}));

/** What local OCR reads per page, for pages with no text layer. */
let recognised: Record<number, TextItemRect[]> = {};
let ocrOn = true;
vi.mock("./ocr/ocr-service", () => ({
  ocrEnabled: () => ocrOn,
  ocrPage: async (_path: string, page: number) =>
    recognised[page] ? { page, items: recognised[page], text: "", confidence: 90, ms: 1 } : null,
}));
vi.mock("./doc-cache", () => ({
  docCache: { get: () => ({ kind: "pdf" }) },
}));

import { clearFindingAnchors } from "./finding-anchors";
import {
  cachedCitationCheck,
  checkAnswer,
  checkCitation,
  clearCitationChecks,
  tallyCitations,
  verifiedSentences,
} from "./citation-check";

const PATH = "/docs/contract.pdf";
const run = (text: string, y = 700): TextItemRect => ({ text, rect: { x: 72, y, width: 400, height: 12 } });

beforeEach(() => {
  pages = {};
  recognised = {};
  ocrOn = true;
  reads = 0;
  clearFindingAnchors();
  clearCitationChecks();
});

describe("checkCitation", () => {
  it("locates a quote on the page it names, with where it is", async () => {
    pages[5] = [run("每逾期一日按逾期金额的万分之三向乙方"), run("支付违约金。", 686)];
    const check = await checkCitation(PATH, 10, { pages: [5], quote: "按逾期金额的万分之三向乙方支付违约金" });
    expect(check.status).toBe("located");
    expect(check.page).toBe(5);
    expect(check.rects).toHaveLength(2);
  });

  it("says unlocated only when the page has text and not these words", async () => {
    pages[5] = [run("每逾期一日按逾期金额的万分之三")];
    expect((await checkCitation(PATH, 10, { pages: [5], quote: "按逾期金额的万分之五" })).status).toBe("unlocated");
  });

  it("never accuses a page it could not read", async () => {
    pages[5] = []; // a scan: no text layer
    expect((await checkCitation(PATH, 10, { pages: [5], quote: "按逾期金额的万分之五" })).status).toBe("unreadable");
    pages[6] = new Error("ipc");
    expect((await checkCitation(PATH, 10, { pages: [6], quote: "按逾期金额的万分之五" })).status).toBe("unreadable");
  });

  it("withholds the accusation when one of a range's pages could not be read", async () => {
    pages[5] = [run("something else entirely")];
    pages[6] = [];
    expect((await checkCitation(PATH, 10, { pages: [5, 6], quote: "the words cited here" })).status).toBe("unreadable");
  });

  it("finds a quote on any page of a range", async () => {
    pages[5] = [run("nothing here of note")];
    pages[6] = [run("the words cited here, exactly")];
    const check = await checkCitation(PATH, 10, { pages: [5, 6], quote: "the words cited here" });
    expect(check).toMatchObject({ status: "located", page: 6 });
  });

  it("flags a page past the end without reading anything", async () => {
    expect((await checkCitation(PATH, 3, { pages: [999], quote: "anything at all" })).status).toBe("outOfRange");
    expect(reads).toBe(0);
  });

  it("treats a page-only citation, or a quote too short to mean anything, as unchecked", async () => {
    pages[2] = [run("Revenue fell.")];
    expect((await checkCitation(PATH, 3, { pages: [2], quote: null })).status).toBe("unchecked");
    expect((await checkCitation(PATH, 3, { pages: [2], quote: "fell" })).status).toBe("unchecked");
  });

  it("reads each page once and remembers the answer for a synchronous caller", async () => {
    pages[1] = [run("the quick brown fox jumps")];
    const c = { pages: [1], quote: "quick brown fox" };
    expect(cachedCitationCheck(PATH, c)).toBeNull();
    await Promise.all([checkCitation(PATH, 3, c), checkCitation(PATH, 3, c)]);
    await checkCitation(PATH, 3, { pages: [1], quote: "brown fox jumps" });
    expect(reads).toBe(1);
    expect(cachedCitationCheck(PATH, c)?.status).toBe("located");
  });

  it("re-checks after a failed read instead of keeping the failure", async () => {
    pages[1] = new Error("ipc");
    const c = { pages: [1], quote: "quick brown fox" };
    expect((await checkCitation(PATH, 3, c)).status).toBe("unreadable");
    pages[1] = [run("the quick brown fox jumps")];
    expect((await checkCitation(PATH, 3, c)).status).toBe("located");
  });
});

describe("on a scanned page (14.0)", () => {
  it("locates a quote among the words OCR recognised, with where they are", async () => {
    recognised[3] = "The filter admits a newcomer only if it is popular".split(" ").map((w, i) => ({
      text: w,
      rect: { x: 72 + i * 40, y: 500, width: 36, height: 11 },
    }));
    const check = await checkCitation(PATH, 10, { pages: [3], quote: "admits a newcomer only if it is popular" });
    expect(check.status).toBe("located");
    expect(check.rects!.length).toBeGreaterThan(0);
  });

  it("calls a quote OCR did not recognise unconfirmed, never unlocated", async () => {
    recognised[3] = [run("The filter admits a newcomer only if it is popular")];
    const check = await checkCitation(PATH, 10, { pages: [3], quote: "the committee rejected every newcomer" });
    expect(check.status).toBe("unconfirmed");
  });

  it("still says unlocated for a page with a real text layer", async () => {
    pages[4] = [run("The filter admits a newcomer only if it is popular")];
    recognised[4] = [run("the committee rejected every newcomer")];
    const check = await checkCitation(PATH, 10, { pages: [4], quote: "the committee rejected every newcomer" });
    expect(check.status).toBe("unlocated");
  });

  it("withholds the accusation when one of the named pages is a scan", async () => {
    pages[4] = [run("Nothing relevant here at all, only other words")];
    recognised[5] = [run("Other recognised words entirely")];
    const check = await checkCitation(PATH, 10, { pages: [4, 5], quote: "the committee rejected every newcomer" });
    expect(check.status).toBe("unconfirmed");
  });
});

describe("tallyCitations", () => {
  it("counts one answer's distinct citations by status", async () => {
    pages[1] = [run("the quick brown fox jumps over")];
    const md = 'A〔p1 "quick brown fox"〕 B〔p1 "slow green turtle"〕 C〔p1〕 D〔p9 "x y z w"〕 A again〔p1 "quick brown fox"〕';
    expect(tallyCitations(PATH, md)).toMatchObject({ total: 4, pending: 4 });
    const tally = await checkAnswer(PATH, 3, md);
    expect(tally).toEqual({ total: 4, located: 1, unlocated: 1, unreadable: 0, unconfirmed: 0, mismatch: 0, unchecked: 1, outOfRange: 1, pending: 0 });
  });
});

describe("verifiedSentences", () => {
  it("returns every located sentence once, and terminates", async () => {
    // Regression: a shared global regex had its lastIndex reset inside this
    // loop, which never ended — the app froze on the first verified answer.
    pages[1] = [run("the quick brown fox jumps over the lazy dog")];
    const md = 'Foxes are quick〔p1 "quick brown fox"〕. Dogs are lazy〔p1 "the lazy dog"〕. Cats fly〔p1 "cats can fly"〕.';
    await checkAnswer(PATH, 3, md);
    expect(verifiedSentences(PATH, md)).toEqual([
      { claim: "Foxes are quick", page: 1, quote: "quick brown fox" },
      { claim: "Dogs are lazy", page: 1, quote: "the lazy dog" },
    ]);
  });
});

describe("B10: a citation found unreadable is checked again (16.0)", () => {
  const quote = "按逾期金额的万分之三向乙方";

  it("once OCR is turned on", async () => {
    ocrOn = false;
    pages[2] = [];
    recognised[2] = [run("每逾期一日按逾期金额的万分之三向乙方")];
    expect((await checkCitation(PATH, 10, { pages: [2], quote })).status).toBe("unreadable");
    ocrOn = true;
    expect((await checkCitation(PATH, 10, { pages: [2], quote })).status).not.toBe("unreadable");
  });

  it("once OCR has read the page it had not read yet", async () => {
    pages[3] = [];
    expect((await checkCitation(PATH, 10, { pages: [3], quote })).status).toBe("unreadable");
    recognised[3] = [run("每逾期一日按逾期金额的万分之三向乙方")];
    expect((await checkCitation(PATH, 10, { pages: [3], quote })).status).not.toBe("unreadable");
  });
});
