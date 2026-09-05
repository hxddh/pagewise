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
