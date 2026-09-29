/**
 * Can a verbatim quote be found again on the page it came from?
 *
 * This is the question every citation check in PageWise rests on, and until
 * 13.0 it had been measured once — in 4.4, on one mathematics textbook, against
 * a matcher that has since been replaced. The assistant reads a page as the
 * Markdown `open_document` produced; a citation is located among the runs
 * `page_text_items` returns. Those are two extraction paths, and a quote copied
 * faithfully from the first has to be found in the second.
 *
 * No model is involved. The quotes are cut from exactly the text the model is
 * given, so a miss here is a miss the model could not have avoided: it copied
 * the words correctly and PageWise still could not find them. That is the
 * number the 13.0 gate is set on.
 *
 * Variants then apply the rewrites a model makes while copying — straight
 * quotes for curly ones, a ligature spelled out, full-width punctuation made
 * half-width. Those are reported beside the gate, not in it: they measure how
 * forgiving the matcher is, not whether it works.
 */
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { locateQuote } from "../src/lib/quote-locate";
import { corpusFiles, loadDoc, OUT, type DumpDoc } from "./lib/corpus";
import { NEGATIVES, quotesFor, rng, type Kind } from "./lib/quotes";

/** What a model tends to do to a quote while copying it. */
const VARIANTS: Record<string, (q: string) => string> = {
  straightQuotes: (q) => q.replace(/[‘’]/g, "'").replace(/[“”]/g, '"'),
  nfkc: (q) => q.normalize("NFKC"),
  ellipsisDots: (q) => q.replace(/…/g, "..."),
};

interface Row {
  doc: string;
  pages: number;
  quotes: number;
  located: number;
  byKind: Record<Kind, [number, number]>;
  variants: Record<string, [number, number]>;
  misses: Array<{ page: number; kind: Kind; text: string }>;
}

function evaluate(doc: DumpDoc): Row {
  const byPage = new Map(doc.pages.map((p) => [p.page, p.items]));
  const row: Row = {
    doc: doc.id,
    pages: doc.page_count,
    quotes: 0,
    located: 0,
    byKind: { sentence: [0, 0], span: [0, 0], cell: [0, 0] },
    variants: Object.fromEntries(Object.keys(VARIANTS).map((k) => [k, [0, 0]])),
    misses: [],
  };
  for (const q of quotesFor(doc)) {
    const items = byPage.get(q.page) ?? [];
    const outcome = locateQuote(items, q.text);
    if (outcome.status === "uncheckable") continue;
    row.quotes += 1;
    row.byKind[q.kind][1] += 1;
    if (outcome.status === "located") {
      row.located += 1;
      row.byKind[q.kind][0] += 1;
    } else if (row.misses.length < 40) {
      row.misses.push({ page: q.page, kind: q.kind, text: q.text });
    }
    for (const [name, fn] of Object.entries(VARIANTS)) {
      const v = fn(q.text);
      if (v === q.text) continue;
      row.variants[name]![1] += 1;
      if (locateQuote(items, v).status === "located") row.variants[name]![0] += 1;
    }
  }
  return row;
}

function falsePositives(doc: DumpDoc): { tried: number; found: number; examples: string[] } {
  const next = rng(doc.page_count * 104729 + 17);
  const byPage = new Map(doc.pages.map((p) => [p.page, p]));
  let tried = 0;
  let found = 0;
  const examples: string[] = [];
  for (const q of quotesFor(doc)) {
    const page = byPage.get(q.page)!;
    // A mutation that happens to be real text elsewhere on the page is not a fabrication.
    const pageFolded = page.items.map((i) => i.text).join("").replace(/\s/g, "").toLowerCase();
    for (const [name, mutate] of Object.entries(NEGATIVES)) {
      const neg = mutate(q.text, next);
      if (!neg || neg === q.text) continue;
      if (pageFolded.includes(neg.replace(/\s/g, "").toLowerCase())) continue;
      const outcome = locateQuote(page.items, neg);
      if (outcome.status === "uncheckable") continue;
      tried += 1;
      if (outcome.status === "located") {
        found += 1;
        if (examples.length < 10) examples.push(`${name} p${q.page}: ${neg}`);
      }
    }
  }
  return { tried, found, examples };
}

const pct = (a: number, b: number) => (b === 0 ? "—" : `${((100 * a) / b).toFixed(1)}%`);

/** The 13.0 gate, on verbatim quotes pooled over the whole corpus. */
export const LOCATION_GATE = 0.9;

/** An altered quote reported as found on the page. */
export const FALSE_POSITIVE_CEILING = 0.01;

describe("citation location rate", () => {
  it("locates verbatim quotes on the page they came from", () => {
    const rows = corpusFiles().map((f) => evaluate(loadDoc(f)));
    const total = rows.reduce((n, r) => n + r.quotes, 0);
    const located = rows.reduce((n, r) => n + r.located, 0);

    const lines = [
      "| document | pages | quotes | located | sentence | span | table cell | curly→straight | NFKC |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
      ...rows.map(
        (r) =>
          `| ${r.doc} | ${r.pages} | ${r.quotes} | ${pct(r.located, r.quotes)} | ` +
          `${pct(...r.byKind.sentence)} | ${pct(...r.byKind.span)} | ${pct(...r.byKind.cell)} | ` +
          `${pct(...r.variants.straightQuotes!)} | ${pct(...r.variants.nfkc!)} |`,
      ),
      `| **all** | | ${total} | **${pct(located, total)}** | | | | | |`,
    ];
    console.log(lines.join("\n"));
    writeFileSync(join(OUT, "location.json"), JSON.stringify({ total, located, rows }, null, 2));

    expect(total).toBeGreaterThan(300);
    expect(located / total).toBeGreaterThanOrEqual(LOCATION_GATE);
  });

  it("does not locate a quote that was altered", () => {
    const rows = corpusFiles().map((f) => ({ doc: loadDoc(f).id, ...falsePositives(loadDoc(f)) }));
    const tried = rows.reduce((n, r) => n + r.tried, 0);
    const found = rows.reduce((n, r) => n + r.found, 0);
    console.log(
      ["| document | altered quotes | wrongly located |", "|---|---:|---:|",
        ...rows.map((r) => `| ${r.doc} | ${r.tried} | ${r.found} |`),
        `| **all** | ${tried} | **${found}** (${pct(found, tried)}) |`].join("\n"),
    );
    for (const r of rows) for (const e of r.examples) console.log(`  ${r.doc}: ${e}`);
    writeFileSync(join(OUT, "false-positives.json"), JSON.stringify({ tried, found, rows }, null, 2));
    expect(tried).toBeGreaterThan(300);
    expect(found / tried).toBeLessThanOrEqual(FALSE_POSITIVE_CEILING);
  });
});
