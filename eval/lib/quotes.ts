/**
 * Quotes cut from a page, and quotes altered so they must not be found.
 *
 * Shared by `location.eval.ts` (text layers) and `ocr.eval.ts` (scans, 14.0),
 * so both measure the same quotes: a scanned page's number is directly
 * comparable with the same page's number when it had a text layer.
 */
import { markdownToPlainText } from "../../src/lib/markdown-text";
import type { DumpDoc } from "./corpus";

/** Deterministic, so two runs sample the same quotes. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export const CJK = /[㐀-鿿豈-﫿]/;

export type Kind = "sentence" | "span" | "cell";
export interface Quote {
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

export function quotesFor(doc: DumpDoc): Quote[] {
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

/**
 * Quotes that must NOT be found: each is a real quote from the page with one
 * change a fabricating or careless model makes. Locating any of them is a
 * false "found on the page", which is worse than a missed true one — it is the
 * whole reason the check exists.
 */
export const NEGATIVES: Record<string, (q: string, next: () => number) => string | null> = {
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

