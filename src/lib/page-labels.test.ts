import { describe, expect, it } from "vitest";
import { describeLabels, labelForPage, normalizeLabels, pageForLabel } from "./page-labels";

/** A book: twelve pages of front matter in roman, then the body restarts at 1. */
const BOOK = normalizeLabels(
  [...["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"],
   ...Array.from({ length: 20 }, (_, i) => String(i + 1))],
  32,
);

describe("normalizeLabels", () => {
  it("keeps labels that say something the page number does not", () => {
    expect(BOOK).not.toBeNull();
    expect(BOOK![0]).toBe("i");
    expect(BOOK![12]).toBe("1");
    expect(BOOK).toHaveLength(32);
  });

  it("returns null when the labels are just the page numbers", () => {
    // The common case by a wide margin. Saying "no labels" here lets every
    // caller skip the mechanism instead of carrying a redundant array and
    // special-casing it.
    expect(normalizeLabels(["1", "2", "3"], 3)).toBeNull();
  });

  it("returns null when the document has none at all", () => {
    expect(normalizeLabels(null, 10)).toBeNull();
    expect(normalizeLabels([], 10)).toBeNull();
    expect(normalizeLabels(["i", "ii"], 0)).toBeNull();
  });

  it("fills a page with no label of its own from its position", () => {
    // pdf.js returns holes for pages a /PageLabels range does not cover. The
    // array must still be total-length or every consumer grows a null check.
    const l = normalizeLabels(["cover", null, undefined, ""], 4);
    expect(l).toEqual(["cover", "2", "3", "4"]);
  });

  it("is always as long as the document, not as long as what it was given", () => {
    expect(normalizeLabels(["i", "ii"], 5)).toHaveLength(5);
    expect(normalizeLabels(["i", "ii", "iii", "iv", "v", "vi"], 3)).toHaveLength(3);
  });

  it("trims a label that is really a sentence", () => {
    const l = normalizeLabels([" A-1 ", "x".repeat(80)], 2);
    expect(l![0]).toBe("A-1");
    expect(l![1].length).toBeLessThanOrEqual(24);
  });
});

describe("labelForPage", () => {
  it("gives the printed number for a page that has one", () => {
    expect(labelForPage(BOOK, 1)).toBe("i");
    expect(labelForPage(BOOK, 13)).toBe("1");
  });

  it("says nothing when the printed number is the page number", () => {
    // Page 14 is printed "2". There is nothing to tell the reader — showing
    // "2 · 14" would be noise on most of the document.
    expect(labelForPage(BOOK, 14)).toBe("2");
    expect(labelForPage(normalizeLabels(["1", "2"], 2), 2)).toBeNull();
    expect(labelForPage(null, 3)).toBeNull();
  });

  it("does not fall off either end", () => {
    expect(labelForPage(BOOK, 0)).toBeNull();
    expect(labelForPage(BOOK, 999)).toBeNull();
  });
});

describe("pageForLabel", () => {
  it("resolves a printed number to the sheet it is printed on", () => {
    // The whole point: the reader says "page 1" meaning the body's first page.
    expect(pageForLabel(BOOK, "1")).toBe(13);
    expect(pageForLabel(BOOK, "iv")).toBe(4);
  });

  it("ignores case and the punctuation a reader types", () => {
    const l = normalizeLabels(["A-1", "A-2", "B-1"], 3);
    expect(pageForLabel(l, "a 1")).toBe(1);
    expect(pageForLabel(l, "A1")).toBe(1);
    expect(pageForLabel(BOOK, "IV")).toBe(4);
  });

  it("refuses an ambiguous number rather than picking one", () => {
    // A document that restarts numbering per chapter prints "1" many times.
    // Answering one at random sends the reader somewhere confidently wrong.
    const l = normalizeLabels(["1", "2", "1", "2"], 4);
    expect(pageForLabel(l, "1")).toBeNull();
    expect(pageForLabel(l, "2")).toBeNull();
  });

  it("says nothing for a number the document does not print", () => {
    expect(pageForLabel(BOOK, "999")).toBeNull();
    expect(pageForLabel(BOOK, "  ")).toBeNull();
    expect(pageForLabel(null, "1")).toBeNull();
  });

  it("round-trips every page of a document that labels them all distinctly", () => {
    // The invariant the two functions owe each other, checked across the whole
    // document rather than on the one page a example would use.
    for (let page = 1; page <= 32; page += 1) {
      const label = BOOK![page - 1];
      const unique = BOOK!.filter((l) => l === label).length === 1;
      if (unique) expect(pageForLabel(BOOK, label), `label "${label}"`).toBe(page);
    }
  });
});

describe("describeLabels", () => {
  it("names the first sheet whose printed number disagrees", () => {
    const out = describeLabels(BOOK);
    expect(out).toContain("sheet 1");
    expect(out).toContain('"i"');
    expect(out).toMatch(/label/);
  });

  it("says nothing at all when there is nothing to say", () => {
    // Every character here rides on a real request. A document numbered the
    // obvious way must cost exactly zero.
    expect(describeLabels(null)).toBe("");
    expect(describeLabels(["1", "2", "3"])).toBe("");
  });

  it("stays one sentence however long the document is", () => {
    // The mapping is deliberately NOT sent — three hundred labels would cost
    // more per question than the pages the question is about.
    const long = normalizeLabels(
      [...Array.from({ length: 40 }, (_, i) => `x${i}`),
       ...Array.from({ length: 960 }, (_, i) => String(i + 1))],
      1000,
    );
    expect(describeLabels(long).length).toBeLessThan(400);
  });
});
