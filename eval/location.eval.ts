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
import { markdownToPlainText } from "../src/lib/markdown-text";
import { corpusFiles, loadDoc, OUT, type DumpDoc } from "./lib/corpus";

/** Deterministic, so two runs sample the same quotes. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const CJK = /[㐀-鿿豈-﫿]/;

type Kind = "sentence" | "span" | "cell";
interface Quote {
  doc: string;
  page: number;
  kind: Kind;
  text: string;
}

/** Sentences, cut the way a reader would: at terminal punctuation or a line end. */
function sentencesOf(plain: string): string[] {
  return plain
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?;。！？；])\s*/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** A 20–45 character stretch from the middle of a sentence, on word boundaries outside CJK. */
function spanOf(sentence: string, next: () => number): string | null {
  const len = CJK.test(sentence) ? 12 + Math.floor(next() * 14) : 20 + Math.floor(next() * 26);
  if (sentence.length < len + 8) return null;
  let start = Math.floor(next() * (sentence.length - len));
  let end = start + len;
  if (!CJK.test(sentence)) {
    while (start > 0 && sentence[start - 1] !== " ") start -= 1;
    while (end < sentence.length && sentence[end] !== " ") end += 1;
  }
  return sentence.slice(start, end).trim();
}

function quotesFor(doc: DumpDoc): Quote[] {
  const next = rng(doc.id.length * 7919 + doc.page_count);
  const out: Quote[] = [];
  for (const page of doc.pages) {
    if (!page.text.trim()) continue;
    // Table rows are quoted cell by cell: a model citing a figure quotes the
    // figure and its label, not the pipes.
    for (const line of page.text.split("\n")) {
      if (!line.trim().startsWith("|") || /^\|[\s:|-]+\|?$/.test(line.trim())) continue;
      const cells = line.split("|").map((c) => c.trim()).filter((c) => c.length >= 6);
      for (const cell of cells) if (next() < 0.5) out.push({ doc: doc.id, page: page.page, kind: "cell", text: cell });
    }
    const plain = markdownToPlainText(page.text.split("\n").filter((l) => !l.trim().startsWith("|")).join("\n"));
    for (const s of sentencesOf(plain)) {
      const min = CJK.test(s) ? 8 : 16;
      if (s.length >= min && s.length <= 240 && next() < 0.6) {
        out.push({ doc: doc.id, page: page.page, kind: "sentence", text: s });
      }
      const span = spanOf(s, next);
      if (span && next() < 0.6) out.push({ doc: doc.id, page: page.page, kind: "span", text: span });
    }
  }
  return out;
}

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

/**
 * Quotes that must NOT be found: each is a real quote from the page with one
 * change a fabricating or careless model makes. Locating any of them is a
 * false "found on the page", which is worse than a missed true one — it is the
 * whole reason the check exists.
 */
const NEGATIVES: Record<string, (q: string, next: () => number) => string | null> = {
  numberChanged: (q) => (/\d/.test(q) ? q.replace(/\d(?!.*\d)/, (d) => String((Number(d) + 3) % 10)) : null),
  wordsSwapped: (q, next) => {
    const words = q.split(" ");
    if (words.length < 4) return null;
    const i = 1 + Math.floor(next() * (words.length - 2));
    // Swapping in a word the matcher does not read (a rule of dashes) changes nothing.
    if (words[i] === words[i - 1] || !/[\p{L}\p{N}]/u.test(words[i]! + "") || !/[\p{L}\p{N}]/u.test(words[i - 1]!)) {
      return null;
    }
    [words[i - 1], words[i]] = [words[i]!, words[i - 1]!];
    return words.join(" ");
  },
  negated: (q) => (CJK.test(q) ? q.replace(/应/, "不应") : q.replace(/\b(is|are|was|can|must|may|will)\b/, "$1 not")),
  charDropped: (q, next) => {
    if (q.length < 12) return null;
    const i = 4 + Math.floor(next() * (q.length - 8));
    // Only a character the matcher reads: dropping a space, a hyphen or a
    // quotation mark is a spelling of the same words by design.
    return /[\p{L}\p{N}]/u.test(q[i]!) ? q.slice(0, i) + q.slice(i + 1) : null;
  },
};

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
