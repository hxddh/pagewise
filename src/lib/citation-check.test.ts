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

describe("tallyCitations", () => {
  it("counts one answer's distinct citations by status", async () => {
    pages[1] = [run("the quick brown fox jumps over")];
    const md = 'A〔p1 "quick brown fox"〕 B〔p1 "slow green turtle"〕 C〔p1〕 D〔p9 "x y z w"〕 A again〔p1 "quick brown fox"〕';
    expect(tallyCitations(PATH, md)).toMatchObject({ total: 4, pending: 4 });
    const tally = await checkAnswer(PATH, 3, md);
    expect(tally).toEqual({ total: 4, located: 1, unlocated: 1, unreadable: 0, unchecked: 1, outOfRange: 1, pending: 0 });
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
