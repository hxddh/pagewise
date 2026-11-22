import { markdownToPlainText } from "./markdown-text";
import type { PageText } from "./types";

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;
const WORD = /[\p{L}\p{N}]+/gu;
const LINE_WRAP_JOIN = /([\p{L}])(?:\u00AD\s*|[-‐‑]\s+)([\p{L}])/gu;
const CJK_SPACE_JOIN = /([㐀-䶿一-鿿豈-﫿぀-ヿ가-힯])\s+([㐀-䶿一-鿿豈-﫿぀-ヿ가-힯])/gu;

const STOP = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its " +
    "may might must no not of on or our shall she should so such than that the their them then there these they this " +
    "those to was we were what when where which who will with would you your about any all also each other page pages " +
    "的 了 和 是 在 与 及 或 等 对 由 中 为 以 之 其 于 被 并 该 此 这 那 有"
  ).split(" "),
);

function stem(word: string): string {
  if (word.length < 4 || /\d/.test(word)) return word;
  if (word.length === 4) {
    if (word === "used" || word === "uses") return "use";
    return word;
  }
  if (word.endsWith("ings") && word.length - 4 >= 3) return word.slice(0, -4);
  if (word.endsWith("ing") && word.length - 3 >= 3) return word.slice(0, -3);
  if (word.endsWith("ies") && word.length - 3 >= 3) return `${word.slice(0, -3)}y`;
  if (/(?:sh|ch|x|z|ss)es$/.test(word) && word.length - 2 >= 3) return word.slice(0, -2);
  if (word.endsWith("ed") && word.length - 2 >= 3) {
    const base = word.slice(0, -2);
    return /(?:[aeiou][^aeiouy]|[cgsvz])$/.test(base) && word.endsWith("eed") === false
      ? word.slice(0, -1)
      : base;
  }
  if (word.endsWith("s") && !word.endsWith("ss") && word.length - 1 >= 3) {
    return word.slice(0, -1);
  }
  return word;
}

export interface TokenizeOptions {
  /** Join OCR/PDF spaces between adjacent CJK characters. Default true (for pages); false for user queries so space-separated CJK terms stay distinct. */
  joinCjkSpaces?: boolean;
  /** Also emit individual words from hyphenated line wraps (`web- proxy` -> `webproxy`, `web`, `proxy`). */
  includeHyphenParts?: boolean;
}

export function tokenize(text: string, options?: TokenizeOptions): string[] {
  const out: string[] = [];
  const joinCjk = options?.joinCjkSpaces ?? true;
  if (options?.includeHyphenParts) {
    for (const hm of text.normalize("NFKC").toLowerCase().matchAll(/([\p{L}]{2,})(?:\u00AD\s*|[-‐‑]\s+)([\p{L}]{2,})/gu)) {
      const a = hm[1]!;
      const b = hm[2]!;
      if (!CJK.test(a) && !STOP.has(a)) out.push(stem(a));
      if (!CJK.test(b) && !STOP.has(b)) out.push(stem(b));
    }
  }
  let joined = text.replace(LINE_WRAP_JOIN, "$1$2");
  if (joinCjk) {
    for (;;) {
      const next = joined.replace(CJK_SPACE_JOIN, "$1$2");
      if (next === joined) break;
      joined = next;
    }
  }
  for (const m of joined.normalize("NFKC").toLowerCase().matchAll(WORD)) {
    const word = m[0];
    if (!CJK.test(word)) {
      if (word.length >= 2 && !STOP.has(word)) out.push(stem(word));
      continue;
    }
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

function cjkUnigrams(text: string): string[] {
  const out: string[] = [];
  for (const m of text.normalize("NFKC").matchAll(/[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]{2,}/g)) {
    for (const ch of m[0]) {
      if (!STOP.has(ch)) out.push(`\0${ch}`);
    }
  }
  return out;
}

interface Index {
  plain: string[];
  tf: Map<string, number>[];
  df: Map<string, number>;
  uniTf: Map<string, number>[];
  uniDf: Map<string, number>;
  lengths: number[];
  avgLength: number;
}

interface TokenizedPageEntry {
  plain: string;
  tf: Map<string, number>;
  uniTf: Map<string, number>;
  length: number;
}

const MAX_PAGE_TOKEN_CACHE = 2_000;
const pageTokenCache = new Map<string, TokenizedPageEntry>();

function tokenizePageEntry(rawMarkdown: string): TokenizedPageEntry {
  const hit = pageTokenCache.get(rawMarkdown);
  if (hit) {
    pageTokenCache.delete(rawMarkdown);
    pageTokenCache.set(rawMarkdown, hit);
    return hit;
  }
  const plain = markdownToPlainText(rawMarkdown);
  const tf = new Map<string, number>();
  let length = 0;
  for (const t of tokenize(plain, { joinCjkSpaces: true, includeHyphenParts: true })) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
    length += 1;
  }
  const uniTf = new Map<string, number>();
  for (const u of cjkUnigrams(plain)) {
    uniTf.set(u, (uniTf.get(u) ?? 0) + 1);
  }
  const entry: TokenizedPageEntry = { plain, tf, uniTf, length };
  pageTokenCache.set(rawMarkdown, entry);
  while (pageTokenCache.size > MAX_PAGE_TOKEN_CACHE) {
    const oldest = pageTokenCache.keys().next().value;
    if (oldest === undefined) break;
    pageTokenCache.delete(oldest);
  }
  return entry;
}

const indexCache = new WeakMap<PageText[], Index>();

function indexOf(pages: PageText[]): Index {
  const hit = indexCache.get(pages);
  if (hit) return hit;
  const entries = pages.map((p) => tokenizePageEntry(p.text));
  const plain = entries.map((e) => e.plain);
  const tf = entries.map((e) => e.tf);
  const df = new Map<string, number>();
  for (const counts of tf) for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);

  const uniTf = entries.map((e) => e.uniTf);
  const uniDf = new Map<string, number>();
  for (const counts of uniTf) for (const u of counts.keys()) uniDf.set(u, (uniDf.get(u) ?? 0) + 1);

  const lengths = entries.map((e) => e.length);
  const totalLen = lengths.reduce((a, b) => a + b, 0);
  const avgLength = totalLen / Math.max(1, lengths.length) || 1;
  const index = { plain, tf, df, uniTf, uniDf, lengths, avgLength };
  indexCache.set(pages, index);
  return index;
}

export interface RankedHit {
  page: number;
  score: number;
  snippet: string;
  terms: string[];
}

const K1 = 1.2;
const B = 0.75;
const UNI_WEIGHT = 0.32;

export function rankPages(pages: PageText[], query: string, limit = 12): RankedHit[] {
  const terms = [...new Set(tokenize(query, { joinCjkSpaces: false }))];
  if (terms.length === 0 || pages.length === 0) return [];
  const uniTerms = [...new Set(cjkUnigrams(query))];
  const index = indexOf(pages);
  const n = pages.length;
  const need = Math.max(1, Math.ceil(terms.length / 2));
  const needUni = uniTerms.length > 0 ? Math.max(1, Math.ceil(uniTerms.length / 2)) : Infinity;

  const tier1: RankedHit[] = [];
  const tier2: RankedHit[] = [];

  for (let i = 0; i < n; i += 1) {
    const counts = index.tf[i]!;
    const lenNorm = K1 * (1 - B + (B * index.lengths[i]!) / index.avgLength);
    let primaryScore = 0;
    const found: string[] = [];
    for (const term of terms) {
      const f = counts.get(term) ?? 0;
      if (f === 0) continue;
      found.push(term);
      const df = index.df.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      primaryScore += idf * ((f * (K1 + 1)) / (f + lenNorm));
    }

    let uniScore = 0;
    const foundUni: string[] = [];
    if (uniTerms.length > 0) {
      const uCounts = index.uniTf[i]!;
      for (const u of uniTerms) {
        const f = uCounts.get(u) ?? 0;
        if (f === 0) continue;
        foundUni.push(u.slice(1));
        const df = index.uniDf.get(u) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        uniScore += UNI_WEIGHT * idf * ((f * (K1 + 1)) / (f + lenNorm));
      }
    }

    if (found.length >= need) {
      tier1.push({
        page: pages[i]!.page,
        score: primaryScore + uniScore,
        snippet: "",
        terms: found,
      });
    } else if (found.length >= 1 || foundUni.length >= needUni) {
      tier2.push({
        page: pages[i]!.page,
        score: primaryScore + uniScore,
        snippet: "",
        terms: found.length > 0 ? found : foundUni,
      });
    }
  }

  tier1.sort((a, b) => b.score - a.score || a.page - b.page);
  tier2.sort((a, b) => b.score - a.score || a.page - b.page);

  let combined: RankedHit[];
  if (tier1.length === 0) {
    combined = tier2;
  } else if (tier1.length < Math.min(limit, 3) && terms.length <= 4) {
    const minBackfillScore = tier1[0]!.score * 0.05;
    const backfill = tier2.filter(
      (h) => h.terms.length >= Math.max(1, need - 1) && h.score >= minBackfillScore,
    );
    combined = [...tier1, ...backfill];
  } else {
    combined = tier1;
  }
  const top = combined.slice(0, limit);
  for (const hit of top) {
    const i = pages.findIndex((p) => p.page === hit.page);
    hit.snippet = snippetFor(index.plain[i] ?? "", hit.terms, index);
  }
  return top;
}

function findSurfaceMatch(text: string, term: string): { at: number; len: number } | null {
  const lower = text.toLowerCase();
  const direct = lower.indexOf(term);
  if (direct >= 0) return { at: direct, len: term.length };

  // Match surface word forms whose stem equals `term` (e.g. `indemnities` -> `indemnity`,
  // `used` -> `use`) so the snippet centers on the actual hit instead of offset 0.
  for (const m of text.matchAll(WORD)) {
    const norm = m[0].normalize("NFKC").toLowerCase();
    if (norm === term || stem(norm) === term || norm.startsWith(term)) {
      return { at: m.index!, len: m[0].length };
    }
  }
  if (CJK.test(term) && term.length >= 2) {
    const first = lower.indexOf(term[0]!);
    if (first >= 0) return { at: first, len: term.length };
  }
  return null;
}

function snippetFor(text: string, terms: string[], index: Index, radius = 80): string {
  const rarest = [...terms].sort(
    (a, b) =>
      (index.df.get(a) ?? index.uniDf.get(`\0${a}`) ?? 0) -
      (index.df.get(b) ?? index.uniDf.get(`\0${b}`) ?? 0),
  );
  let at = -1;
  let len = 0;
  for (const term of rarest) {
    const hit = findSurfaceMatch(text, term);
    if (hit) {
      at = hit.at;
      len = hit.len;
      break;
    }
  }
  if (at < 0) at = 0;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + len + radius);
  const chunk = text.slice(start, end).replace(/\s+/g, " ").trim();
  return start > 0 ? `…${chunk}` : chunk;
}
