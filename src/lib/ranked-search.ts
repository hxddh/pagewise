/**
 * Which pages are about these words, when no page has them as written.
 *
 * `search_in_document` was an exact substring match, and nothing else. A
 * question asked in the reader's words rather than the document's — "late
 * payment penalty" against a contract that says "overdue amount … liquidated
 * damages", "违约责任" against "违约金" — found nothing, and the model's next
 * move was to page through the document at full price. Measured on the 13.0
 * evaluation corpus, see `eval/search.eval.ts`.
 *
 * This is BM25 over the pages: each query term scored by how rare it is in the
 * document and how often it occurs on the page, with long pages discounted.
 * Terms are words for alphabetic scripts, lightly stemmed so "payments" meets
 * "payment", and overlapping character pairs for CJK, where there are no
 * spaces to split on and a two-character pair is the unit most words share.
 *
 * It is lexical, not semantic, deliberately: no model, no embeddings, nothing
 * leaves the machine, and it is deterministic enough to measure. It runs only
 * after exact matches, and its hits say so, so the model can tell "the page
 * has your phrase" from "the page has your words".
 */
import { markdownToPlainText } from "./markdown-text";
import type { PageText } from "./types";

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;
const WORD = /[\p{L}\p{N}]+/gu;

/** Words too common to say anything about which page is meant. */
const STOP = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its " +
    "may might must no not of on or our shall she should so such than that the their them then there these they this " +
    "those to was we were what when where which who will with would you your about any all also each other page pages " +
    "的 了 和 是 在 与 及 或 等 对 由 中 为 以 之 其 于 被 并 该 此 这 那 有"
  ).split(" "),
);

/**
 * Strip plural and verb inflections. Crude and symmetric — enough for
 * "payments"/"payment" and "terminating"/"terminated". Derivational suffixes
 * ("-ment", "-ation") are left alone: "payment" stemmed to "pay" would meet
 * every page that says "pay".
 */
function stem(word: string): string {
  if (word.length <= 4 || /\d/.test(word)) return word;
  for (const suffix of ["ings", "ing", "ies", "es", "ed", "s"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return suffix === "ies" ? `${word.slice(0, -3)}y` : word.slice(0, -suffix.length);
    }
  }
  return word;
}

/** The terms of a text, in order. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.normalize("NFKC").toLowerCase().matchAll(WORD)) {
    const word = m[0];
    if (!CJK.test(word)) {
      if (word.length >= 2 && !STOP.has(word)) out.push(stem(word));
      continue;
    }
    // Mixed runs ("第5条", "HY-DR760型") are split into their CJK and other parts.
    for (const part of word.match(/[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]+|[^㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]+/g) ?? []) {
      if (!CJK.test(part)) {
        if (part.length >= 2 && !STOP.has(part)) out.push(stem(part));
        continue;
      }
      const chars = [...part];
      if (chars.length === 1) {
        if (!STOP.has(chars[0]!)) out.push(chars[0]!);
        continue;
      }
      for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i]! + chars[i + 1]!);
    }
  }
  return out;
}

interface Index {
  plain: string[];
  /** Term frequencies per page. */
  tf: Map<string, number>[];
  /** Pages containing each term. */
  df: Map<string, number>;
  lengths: number[];
  avgLength: number;
}

const indexCache = new WeakMap<PageText[], Index>();

function indexOf(pages: PageText[]): Index {
  const hit = indexCache.get(pages);
  if (hit) return hit;
  const plain = pages.map((p) => markdownToPlainText(p.text));
  const tf = plain.map((text) => {
    const counts = new Map<string, number>();
    for (const t of tokenize(text)) counts.set(t, (counts.get(t) ?? 0) + 1);
    return counts;
  });
  const df = new Map<string, number>();
  for (const counts of tf) for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const lengths = tf.map((counts) => [...counts.values()].reduce((a, b) => a + b, 0));
  const avgLength = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length) || 1;
  const index = { plain, tf, df, lengths, avgLength };
  indexCache.set(pages, index);
  return index;
}

export interface RankedHit {
  page: number;
  score: number;
  snippet: string;
  /** The query terms this page has, as they were searched for. */
  terms: string[];
}

const K1 = 1.2;
const B = 0.75;

/**
 * Pages ranked by how well they carry the query's terms.
 *
 * A page must carry at least half of the query's distinct terms (and at least
 * one): a long query otherwise ranks every page that shares one common word
 * with it, which is noise the model then pays to read.
 */
export function rankPages(pages: PageText[], query: string, limit = 12): RankedHit[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || pages.length === 0) return [];
  const index = indexOf(pages);
  const n = pages.length;
  const need = Math.max(1, Math.ceil(terms.length / 2));

  const scored: RankedHit[] = [];
  for (let i = 0; i < n; i += 1) {
    const counts = index.tf[i]!;
    let score = 0;
    const found: string[] = [];
    for (const term of terms) {
      const f = counts.get(term) ?? 0;
      if (f === 0) continue;
      found.push(term);
      const df = index.df.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * index.lengths[i]!) / index.avgLength)));
    }
    if (found.length < need) continue;
    scored.push({ page: pages[i]!.page, score, snippet: "", terms: found });
  }
  scored.sort((a, b) => b.score - a.score || a.page - b.page);
  const top = scored.slice(0, limit);
  for (const hit of top) {
    const i = pages.findIndex((p) => p.page === hit.page);
    hit.snippet = snippetFor(index.plain[i] ?? "", hit.terms, index);
  }
  return top;
}

/** Context around the rarest of the page's matching terms. */
function snippetFor(text: string, terms: string[], index: Index, radius = 80): string {
  const rarest = [...terms].sort((a, b) => (index.df.get(a) ?? 0) - (index.df.get(b) ?? 0));
  const lower = text.toLowerCase();
  let at = -1;
  let len = 0;
  for (const term of rarest) {
    at = lower.indexOf(term);
    if (at >= 0) {
      len = term.length;
      break;
    }
  }
  if (at < 0) at = 0;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + len + radius);
  const chunk = text.slice(start, end).replace(/\s+/g, " ").trim();
  return start > 0 ? `…${chunk}` : chunk;
}
