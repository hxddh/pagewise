import { describe, expect, it } from "vitest";
import { locateQuote, unionRect, MIN_QUOTE_CHARS } from "./quote-locate";
import type { TextItemRect } from "./types";

/**
 * Finding the assistant's own words on the page.
 *
 * The assistant supplies wording, never coordinates; the anchor is derived here
 * from the page's own text runs. The failure case is the valuable one — a quote
 * that is not on the page it was attributed to is a citation that is not there,
 * and this is the only place that can say so.
 */

const run = (text: string, y: number): TextItemRect => ({
  text,
  rect: { x: 72, y, width: 400, height: 12 },
});

describe("locateQuote", () => {
  it("finds a quote that sits inside one run", () => {
    const items = [run("Revenue fell by twelve percent.", 700), run("Costs were flat.", 686)];
    const out = locateQuote(items, "fell by twelve percent");
    expect(out.status).toBe("located");
    if (out.status !== "located") return;
    expect(out.items.map((i) => i.text)).toEqual(["Revenue fell by twelve percent."]);
  });

  it("finds a quote broken across lines", () => {
    // The limit `matchingItems` documents and accepts — "a phrase broken across
    // two lines matches neither" — is exactly what a sentence-long piece of
    // evidence always is, so this is the case that has to work.
    const items = [run("Revenue fell by twelve", 700), run("percent in the second half.", 686)];
    const out = locateQuote(items, "fell by twelve percent in the second half");
    expect(out.status).toBe("located");
    if (out.status !== "located") return;
    expect(out.items).toHaveLength(2);
  });

  it("finds a wrapped CJK quote, where a line break is not a word boundary", () => {
    // Joining runs with a space would insert one in the middle of a sentence
    // the quote does not have. Dropping whitespace from both sides is the rule
    // that handles wrapped English and wrapped Chinese identically.
    const items = [run("收入在下半年下降了", 700), run("百分之十二。", 686)];
    const out = locateQuote(items, "收入在下半年下降了百分之十二");
    expect(out.status).toBe("located");
    if (out.status !== "located") return;
    expect(out.items).toHaveLength(2);
  });

  it("ignores how the quote itself is spaced and cased", () => {
    const items = [run("Revenue fell by twelve percent.", 700)];
    expect(locateQuote(items, "  REVENUE   fell\nby TWELVE percent ").status).toBe("located");
  });

  it("reports a quote that is not on the page as absent", () => {
    // The fabrication signal. Nothing else in the app can produce it.
    const items = [run("Revenue fell by twelve percent.", 700)];
    expect(locateQuote(items, "revenue rose by twelve percent").status).toBe("absent");
  });

  it("reports a page with no text runs as unreadable, never as absent", () => {
    // A scan has no runs. Until 12.0 this was "absent", and the record panel
    // turned it into "this wording is not on the page it cites" — about a
    // page the app had never been able to look at. Nothing was confirmed and
    // nothing was doubted; the outcome has to say exactly that.
    expect(locateQuote([], "revenue fell by twelve percent").status).toBe("unreadable");
  });

  it("still says absent when the page has text and the quote is not in it", () => {
    const items = [run("Costs were flat.", 700)];
    expect(locateQuote(items, "revenue fell by twelve percent").status).toBe("absent");
  });

  it("refuses to judge a quote too short to mean anything", () => {
    // Four characters occur on nearly every page, so "found" would be noise and
    // "not found" would be an accusation. Neither is said.
    const items = [run("Revenue fell by twelve percent.", 700)];
    expect(locateQuote(items, "fell").status).toBe("uncheckable");
    expect("fell".length).toBeLessThan(MIN_QUOTE_CHARS);
    expect(locateQuote(items, "   ").status).toBe("uncheckable");
  });

  it("counts folded characters, not raw ones, against the minimum", () => {
    const items = [run("Revenue fell by twelve percent.", 700)];
    // Four characters of substance, spread over nine. Whitespace is not
    // evidence, so this is judged as the short quote it is — while the same
    // string measured raw would clear the minimum and be located.
    expect("f e l l".length).toBeGreaterThanOrEqual(MIN_QUOTE_CHARS);
    expect(locateQuote(items, "f e l l").status).toBe("uncheckable");
  });

  it("returns the runs in document order, spanning first to last", () => {
    const items = [run("alpha", 700), run("beta", 686), run("gamma", 672), run("delta", 658)];
    const out = locateQuote(items, "betagammadel");
    expect(out.status).toBe("located");
    if (out.status !== "located") return;
    expect(out.items.map((i) => i.text)).toEqual(["beta", "gamma", "delta"]);
  });

  it("matches a word hyphenated across a break", () => {
    // Recorded as a known limit at 10.0 and counted by the 11.0 review among
    // the ways a true citation was reported as not on its page. Hyphens are
    // dropped from both sides now, so the break costs nothing.
    const items = [run("Reve-", 700), run("nue fell sharply.", 686)];
    const out = locateQuote(items, "revenue fell sharply");
    expect(out.status).toBe("located");
    if (out.status !== "located") return;
    expect(out.items).toHaveLength(2);
  });

  it("treats a hyphen in the quote and none on the page as the same word", () => {
    const items = [run("They reenter the market in May.", 700)];
    expect(locateQuote(items, "re-enter the market").status).toBe("located");
    // And an en dash on the page against a hyphen in the quote.
    expect(locateQuote([run("pages 12–15 cover it", 700)], "pages 12-15 cover").status).toBe(
      "located",
    );
  });

  it("survives a fold that changes length", () => {
    // `toLowerCase` on U+0130 yields two code units. Folding the whole string
    // at once desyncs every offset after it — the trap `document-search.ts`
    // documents, and the reason folding here is per code point.
    const items = [run("İstanbul office closed", 700)];
    const out = locateQuote(items, "stanbul office closed");
    expect(out.status).toBe("located");
    if (out.status !== "located") return;
    expect(out.items).toHaveLength(1);
  });
});

/** A run at an explicit position, for the layouts the fast path cannot read. */
const at = (text: string, x: number, y: number, width = 200): TextItemRect => ({
  text,
  rect: { x, y, width, height: 10 },
});

describe("locateQuote — reading order (13.0)", () => {
  /**
   * `page_text_items` lists runs top to bottom across the page, so two columns
   * arrive interleaved line by line. Before 13.0 the page was read as one
   * string in that order, and quotes from two-column documents were found 40%
   * of the time on the evaluation corpus.
   */
  const twoColumns = [
    at("A cache that admits every", 60, 700),
    at("cache of capacity C bytes", 320, 700),
    at("object it fetches is making", 60, 688),
    at("serves a request from memory", 320, 688),
    at("a bet on reuse.", 60, 676),
    at("if the object is resident.", 320, 676),
  ];

  it("follows a sentence down one column of a two-column page", () => {
    const out = locateQuote(twoColumns, "admits every object it fetches is making a bet");
    expect(out.status).toBe("located");
    if (out.status !== "located") return;
    expect(out.items.map((i) => i.text)).toEqual([
      "A cache that admits every",
      "object it fetches is making",
      "a bet on reuse.",
    ]);
  });

  it("does not follow a sentence into the other column", () => {
    // Left line one, then right line two: adjacent to nobody in the list, and
    // not the next line of the same column either.
    expect(locateQuote(twoColumns, "admits every serves a request").status).toBe("absent");
  });

  it("continues from the foot of one column to the head of the next", () => {
    const items = [at("the end of the left", 60, 100), at("column carries on here", 320, 700)];
    expect(locateQuote(items, "end of the left column carries on").status).toBe("located");
  });

  it("will not reorder words that the page splits into one run each", () => {
    // Justified lines are often one run per word. If any run that continued
    // the quote could come next, "most real" would match "real most" — the
    // first version of the chain did, on 6% of deliberately altered quotes.
    const words = ["small", "objects", "that", "most", "real", "traces"];
    let x = 60;
    const items = words.map((w) => {
      const item = at(w, x, 500, w.length * 5);
      x += w.length * 5 + 4;
      return item;
    });
    expect(locateQuote(items, "objects that most real traces").status).toBe("located");
    expect(locateQuote(items, "objects that real most traces").status).toBe("absent");
  });
});

describe("locateQuote — what a model does while copying (13.0)", () => {
  it("matches straight quotes against curly ones, and the reverse", () => {
    expect(locateQuote([run("the filter’s benefit disappears", 700)], "the filter's benefit").status).toBe("located");
    expect(locateQuote([run('he said "stop" twice', 700)], "he said “stop” twice").status).toBe("located");
  });

  it("matches a ligature on the page against the letters typed for it", () => {
    expect(locateQuote([run("the e\uFB03cient path", 700)], "the efficient path").status).toBe("located");
  });

  it("matches full-width punctuation against half-width", () => {
    expect(locateQuote([run("合同总价为人民币（¥4,368,000.00）", 700)], "合同总价为人民币(¥4,368,000.00)").status).toBe(
      "located",
    );
  });

  it("still refuses a changed number", () => {
    expect(locateQuote([run("by 7.4% on average", 700)], "by 7.9% on average").status).toBe("absent");
  });
});

describe("unionRect", () => {
  it("covers every run of a located quote", () => {
    const rects = [
      { x: 72, y: 700, width: 100, height: 12 },
      { x: 60, y: 686, width: 200, height: 12 },
    ];
    expect(unionRect(rects)).toEqual({ x: 60, y: 686, width: 200, height: 26 });
  });

  it("is null when there is nothing to cover", () => {
    expect(unionRect([])).toBeNull();
  });
});
