import { describe, expect, it } from "vitest";
import {
  extractCitations,
  hideOpenCitation,
  parseCitation,
  sentenceBefore,
  MAX_CITATION_PAGES,
} from "./citations";
import { citationUrl, parseCitationUrl, citationLabel } from "./remark-citations";

describe("parseCitation", () => {
  it("reads a page and a quote", () => {
    expect(parseCitation('p12 "按日万分之五计收违约金"')).toEqual({ pages: [12], quote: "按日万分之五计收违约金" });
  });

  it("reads every quote style a model uses", () => {
    for (const q of ['"x y z"', "“x y z”", "「x y z」", "『x y z』"]) {
      expect(parseCitation(`p3 ${q}`)?.quote).toBe("x y z");
    }
  });

  it("reads a range, and refuses one too wide to be a passage", () => {
    expect(parseCitation("p4-6")?.pages).toEqual([4, 5, 6]);
    expect(parseCitation("p4–5 “a b c”")?.pages).toEqual([4, 5]);
    expect(parseCitation(`p1-${MAX_CITATION_PAGES + 1}`)).toBeNull();
  });

  it("accepts a page without a quote — followable, not checkable", () => {
    expect(parseCitation("p7")).toEqual({ pages: [7], quote: null });
  });

  it("parses and ignores the reserved document handle", () => {
    expect(parseCitation('d2 p9 "abc def"')).toEqual({ pages: [9], quote: "abc def" });
  });

  it("leaves anything else as text", () => {
    expect(parseCitation("note")).toBeNull();
    expect(parseCitation("p0")).toBeNull();
    expect(parseCitation("p5 see the table")).toBeNull();
  });
});

describe("extractCitations", () => {
  it("finds every marker in order and skips ones that do not parse", () => {
    const md = '甲方应付款〔p5 "三十日内"〕，乙方〔旁注〕应交货〔p3 "四十五日内"〕。';
    expect(extractCitations(md).map((c) => c.pages[0])).toEqual([5, 3]);
  });

  it("does not run a marker across a line break", () => {
    expect(extractCitations('a〔p1 "x\ny"〕')).toEqual([]);
  });
});

describe("hideOpenCitation", () => {
  it("drops a marker the stream has not closed", () => {
    expect(hideOpenCitation('费用〔p12 "按日')).toBe("费用");
  });

  it("keeps a closed one, and a bracket that was never a marker", () => {
    expect(hideOpenCitation('费用〔p12 "x"〕')).toBe('费用〔p12 "x"〕');
    expect(hideOpenCitation("a〔b\nc")).toBe("a〔b\nc");
  });
});

describe("sentenceBefore", () => {
  it("is the sentence a marker stands behind", () => {
    const md = '合同总价为四百余万元。逾期付款按日计息〔p5 "按日"〕。';
    expect(sentenceBefore(md, md.indexOf("〔"))).toBe("逾期付款按日计息");
  });

  it("drops earlier markers and Markdown emphasis", () => {
    const md = 'First point〔p1 "a b c"〕 and **second** point〔p2 "d e f"〕.';
    expect(sentenceBefore(md, md.lastIndexOf("〔"))).toBe("First point and second point");
  });
});

describe("citation links", () => {
  it("round-trip through their URL", () => {
    const link = { pages: [3, 4], quote: "a “quoted” b & c" };
    expect(parseCitationUrl(citationUrl(link))).toEqual(link);
  });

  it("label a range by its ends", () => {
    expect(citationLabel([12])).toBe("12");
    expect(citationLabel([4, 5, 6])).toBe("4–6");
  });
});
