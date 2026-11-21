/**
 * Deterministic quote location on a page's text runs, including two-column
 * reading order, bracketed/spaced elisions, inline formatting tags, and
 * cross-page seam quotes.
 */
import type { PdfRect, TextItemRect } from "./types";

export const MIN_QUOTE_CHARS = 6;
export const MAX_QUOTE_ITEMS = 40;

export type LocateOutcome =
  | { status: "located"; items: TextItemRect[]; rects: PdfRect[] }
  | { status: "absent" }
  | { status: "uncheckable" }
  | { status: "unreadable" };

export interface CrossPageLocated {
  status: "located";
  first: { items: TextItemRect[]; rects: PdfRect[] };
  second: { items: TextItemRect[]; rects: PdfRect[] };
}

const DROPPED = /[\s\-\u00AD\u2010\u2011\u2012\u2013\u2014\u2212*#\\|]/;
const QUOTE_MARKS = /['"`\u00B4\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\u2032\u2033\u300C\u300D\u300E\u300F\uFF02\uFF07]/;
const INLINE_HTML_TAG = /<\/?(?:u|br|sup|sub|b|i|em|strong)\s*\/?>/gi;

function stripInlineHtml(text: string): string {
  return text.replace(INLINE_HTML_TAG, (m) => " ".repeat(m.length));
}

function fold(text: string): { folded: string; source: number[] } {
  const cleaned = stripInlineHtml(text);
  let folded = "";
  const source: number[] = [];
  let offset = 0;
  for (const ch of cleaned) {
    const width = ch.length;
    for (const unit of ch.normalize("NFKC").toLowerCase()) {
      if (DROPPED.test(unit) || QUOTE_MARKS.test(unit)) continue;
      folded += unit;
      source.push(offset);
    }
    offset += width;
  }
  return { folded, source };
}

interface FoldedPage {
  folded: string;
  itemAt: number[];
  parts: string[];
  runStart: number[];
  runEnd: number[];
}

const foldedCache = new WeakMap<readonly TextItemRect[], FoldedPage>();

function foldItems(items: readonly TextItemRect[]): FoldedPage {
  const hit = foldedCache.get(items);
  if (hit) return hit;
  let folded = "";
  const itemAt: number[] = [];
  const parts: string[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const { folded: part } = fold(items[i]!.text.normalize("NFC"));
    parts.push(part);
    folded += part;
    for (let k = 0; k < part.length; k += 1) itemAt.push(i);
  }
  const runStart: number[] = [];
  const runEnd: number[] = [];
  for (let c = itemAt.length - 1; c >= 0; c -= 1) runStart[itemAt[c]!] = c;
  for (let c = 0; c < itemAt.length; c += 1) runEnd[itemAt[c]!] = c + 1;
  const entry: FoldedPage = { folded, itemAt, parts, runStart, runEnd };
  foldedCache.set(items, entry);
  return entry;
}

export function locateQuote(items: readonly TextItemRect[], quote: string): LocateOutcome {
  const { folded: needle } = fold((quote ?? "").normalize("NFC"));
  if (needle.length < MIN_QUOTE_CHARS) return { status: "uncheckable" };
  if (items.length === 0) return { status: "unreadable" };

  const page = foldItems(items);
  const at = page.folded.indexOf(needle);
  if (at >= 0) {
    const first = page.itemAt[at]!;
    const last = page.itemAt[at + needle.length - 1]!;
    const span = items.slice(first, Math.min(last + 1, first + MAX_QUOTE_ITEMS));
    return { status: "located", items: span, rects: span.map((item) => item.rect) };
  }

  const chain = chainLocate(items, needle);
  if (chain) {
    const span = chain.map((i) => items[i]!);
    return { status: "located", items: span, rects: span.map((item) => item.rect) };
  }
  return locateElided(items, quote, page) ?? { status: "absent" };
}

/**
 * Return up to `maxMatches` distinct occurrences of `quote` on the page so
 * repeated short quotes (e.g. `"$5,000"` in two clauses or table rows) can be
 * disambiguated against the claim sentence's surrounding numbers and polarity.
 */
export function locateQuoteAll(
  items: readonly TextItemRect[],
  quote: string,
  maxMatches = 6,
): Array<{ items: TextItemRect[]; rects: PdfRect[] }> {
  const { folded: needle } = fold((quote ?? "").normalize("NFC"));
  if (needle.length < MIN_QUOTE_CHARS || items.length === 0) return [];

  const page = foldItems(items);
  const matches: Array<{ items: TextItemRect[]; rects: PdfRect[] }> = [];
  let from = 0;
  while (matches.length < maxMatches) {
    const at = page.folded.indexOf(needle, from);
    if (at < 0) break;
    const first = page.itemAt[at]!;
    const last = page.itemAt[at + needle.length - 1]!;
    const span = items.slice(first, Math.min(last + 1, first + MAX_QUOTE_ITEMS));
    matches.push({ items: span, rects: span.map((it) => it.rect) });
    from = at + Math.max(1, needle.length);
  }
  if (matches.length > 0) return matches;

  const chains = chainLocateAll(items, needle, 0, maxMatches);
  for (const ch of chains) {
    const span = ch.map((i) => items[i]!);
    matches.push({ items: span, rects: span.map((it) => it.rect) });
  }
  if (matches.length > 0) return matches;

  const elided = locateElided(items, quote, page);
  if (elided?.status === "located") {
    matches.push({ items: elided.items, rects: elided.rects });
  }
  return matches;
}

const ELISION_DETECT = /\[?\s*(?:…|\.{3,}|⋯|(?:\.\s+){2,}\.)\s*\]?/;
const ELISION_SPLIT = /\s*(?:\[\s*(?:…|\.{3,}|⋯|(?:\.\s+){2,}\.)\s*\]|…|\.{3,}|⋯|(?:\.\s+){2,}\.)\s*/;
const ELISION_MAX_GAP = 600;

interface PartCandidate {
  runs: number[];
  start: number;
  end: number;
}

function validElisionTransition(
  prevLastRun: number,
  nextFirstRun: number,
  usedChain: boolean,
): boolean {
  if (prevLastRun < 0) return true;
  return !usedChain || nextFirstRun >= prevLastRun;
}

function locateElided(
  items: readonly TextItemRect[],
  quote: string,
  page: FoldedPage,
): LocateOutcome | null {
  if (!ELISION_DETECT.test(quote)) return null;
  const parts = quote
    .split(ELISION_SPLIT)
    .map((part) => fold(part.normalize("NFC")).folded)
    .filter((part) => part.length > 0);
  if (parts.length < 2 || parts.some((part) => part.length < MIN_QUOTE_CHARS)) return null;

  interface PartMatch extends PartCandidate {
    usedChain: boolean;
  }

  const candidatesFor = (part: string, minStart: number): PartMatch[] => {
    const cands: PartMatch[] = [];
    let from = Math.max(0, minStart);
    while (cands.length < 16) {
      const at = page.folded.indexOf(part, from);
      if (at < 0) break;
      if (minStart >= 0 && at - minStart > ELISION_MAX_GAP) break;
      const a = page.itemAt[at]!;
      const b = page.itemAt[at + part.length - 1]!;
      cands.push({
        runs: Array.from({ length: b - a + 1 }, (_, k) => a + k),
        start: at,
        end: at + part.length,
        usedChain: false,
      });
      from = at + 1;
    }
    const chains = chainLocateAll(items, part, Math.max(0, minStart));
    for (const ch of chains) {
      const start = page.runStart[ch[0]!] ?? 0;
      if (minStart >= 0 && start - minStart > ELISION_MAX_GAP) continue;
      const end = Math.max(...ch.map((i) => page.runEnd[i] ?? 0));
      cands.push({ runs: ch, start, end, usedChain: true });
    }
    return cands;
  };

  let visits = 0;
  const search = (idx: number, prevEnd: number, prevRun: number): number[][] | null => {
    if (idx >= parts.length) return [];
    if (visits > 160) return null;
    for (const cand of candidatesFor(parts[idx]!, prevEnd)) {
      visits += 1;
      if (!validElisionTransition(prevRun, cand.runs[0]!, cand.usedChain)) continue;
      const rest = search(idx + 1, cand.end, cand.runs[cand.runs.length - 1]!);
      if (rest !== null) return [cand.runs, ...rest];
    }
    return null;
  };

  const matched = search(0, -1, -1);
  if (!matched) return null;
  const runSet = new Set<number>();
  for (const group of matched) for (const r of group) runSet.add(r);
  const span = [...runSet].sort((a, b) => a - b).slice(0, MAX_QUOTE_ITEMS).map((i) => items[i]!);
  return { status: "located", items: span, rects: span.map((item) => item.rect) };
}

/**
 * Locate a quote that starts near the foot of `itemsA` and continues near the
 * head of `itemsB`, tolerating a short running page number / header in the seam.
 */
export function locateAcrossPages(
  itemsA: readonly TextItemRect[],
  itemsB: readonly TextItemRect[],
  quote: string,
): CrossPageLocated | null {
  const { folded: needle } = fold((quote ?? "").normalize("NFC"));
  if (needle.length < Math.max(MIN_QUOTE_CHARS, 10) || itemsA.length === 0 || itemsB.length === 0) {
    return null;
  }
  const pageA = foldItems(itemsA);
  const pageB = foldItems(itemsB);
  if (pageA.folded.length === 0 || pageB.folded.length === 0) return null;

  const SEAM_ALLOWANCE = 180;
  const tailWindowStart = Math.max(0, pageA.folded.length - (needle.length + SEAM_ALLOWANCE));
  const headWindowEnd = Math.min(pageB.folded.length, needle.length + SEAM_ALLOWANCE);
  const headSlice = pageB.folded.slice(0, headWindowEnd);

  for (let split = needle.length - 4; split >= 4; split -= 1) {
    const left = needle.slice(0, split);
    const right = needle.slice(split);
    if (left.length < MIN_QUOTE_CHARS && right.length < MIN_QUOTE_CHARS) continue;

    const atA = pageA.folded.lastIndexOf(left);
    if (atA < tailWindowStart) continue;
    if (pageA.folded.length - (atA + left.length) > SEAM_ALLOWANCE) continue;

    const atB = headSlice.indexOf(right);
    if (atB < 0 || atB > SEAM_ALLOWANCE) continue;

    const aFirst = pageA.itemAt[atA]!;
    const aLast = pageA.itemAt[atA + left.length - 1]!;
    const bFirst = pageB.itemAt[atB]!;
    const bLast = pageB.itemAt[atB + right.length - 1]!;
    const spanA = itemsA.slice(aFirst, Math.min(aLast + 1, aFirst + MAX_QUOTE_ITEMS));
    const spanB = itemsB.slice(bFirst, Math.min(bLast + 1, bFirst + MAX_QUOTE_ITEMS));
    return {
      status: "located",
      first: { items: spanA, rects: spanA.map((it) => it.rect) },
      second: { items: spanB, rects: spanB.map((it) => it.rect) },
    };
  }
  return null;
}

const CHAIN_VISIT_BUDGET = 20_000;
const CHAIN_MAX_ITEMS = 6_000;

interface Layout {
  right: number[];
  adjRowRight: number[];
  lineStart: boolean[];
  segLeft: number[];
  hasLineBelow: boolean[];
}

const layoutCache = new WeakMap<readonly TextItemRect[], Layout>();

function sameLine(a: PdfRect, b: PdfRect): boolean {
  return Math.abs(a.y - b.y) < Math.max(a.height, b.height) * 0.6;
}

function layoutOf(items: readonly TextItemRect[], parts: readonly string[]): Layout {
  const cached = layoutCache.get(items);
  if (cached) return cached;
  const n = items.length;
  const right = new Array<number>(n).fill(-1);
  const adjRowRight = new Array<number>(n).fill(-1);
  const left = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i += 1) {
    if ((parts[i]?.length ?? 0) === 0) continue;
    const a = items[i]!.rect;
    const gap = Math.max(a.height, 1) * 1.5;
    let best = -1;
    let bestGap = Infinity;
    let rowBest = -1;
    let rowBestGap = Infinity;
    for (let j = 0; j < n; j += 1) {
      if (j === i || (parts[j]?.length ?? 0) === 0) continue;
      const b = items[j]!.rect;
      if (!sameLine(a, b)) continue;
      const g = b.x - (a.x + a.width);
      if (g > -a.height * 0.5 && b.x > a.x) {
        if (g < gap && g < bestGap) {
          best = j;
          bestGap = g;
        }
        // Table-cell horizontal adjacency (`gap <= g < 260`) only between compact
        // cells (`< 180pt`) so two full-width prose columns never bridge mid-page.
        if (g >= gap && g < 260 && Math.min(a.width, b.width) < 180 && g < rowBestGap) {
          rowBest = j;
          rowBestGap = g;
        }
      }
    }
    right[i] = best;
    adjRowRight[i] = rowBest;
    if (best >= 0 && left[best] < 0) left[best] = i;
  }
  const segLeft = items.map((item, i) => {
    let k = i;
    for (let guard = 0; left[k]! >= 0 && guard < n; guard += 1) k = left[k]!;
    return k === i ? item.rect.x : items[k]!.rect.x;
  });
  const layout: Layout = {
    right,
    adjRowRight,
    lineStart: left.map((l) => l < 0),
    segLeft,
    hasLineBelow: [],
  };
  layout.hasLineBelow = items.map((_, i) =>
    items.some((__, j) => j !== i && isLineBelow(items, layout, i, j)),
  );
  layoutCache.set(items, layout);
  return layout;
}

function nextScore(items: readonly TextItemRect[], layout: Layout, a: number, b: number): number | null {
  if (layout.right[a] === b) return 0;
  if (layout.adjRowRight[a] === b) return 2;
  if (!layout.lineStart[b]) return null;
  const ra = items[a]!.rect;
  const rb = items[b]!.rect;
  if (isLineBelow(items, layout, a, b)) return 10 + (ra.y - rb.y);
  if (rb.x >= ra.x + ra.width && rb.y > ra.y && !sameLine(ra, rb) && !layout.hasLineBelow[a]) {
    return 10_000 - rb.y;
  }
  return null;
}

function isLineBelow(items: readonly TextItemRect[], layout: Layout, a: number, b: number): boolean {
  if (!layout.lineStart[b]) return false;
  const ra = items[a]!.rect;
  const rb = items[b]!.rect;
  const h = Math.max(ra.height, rb.height, 1);
  const drop = ra.y - rb.y;
  return drop > h * 0.4 && drop < h * 3.2 && Math.abs(rb.x - layout.segLeft[a]!) < h * 4;
}

function chainLocate(items: readonly TextItemRect[], needle: string): number[] | null {
  const first = chainLocateAll(items, needle, 0, 1);
  return first[0] ?? null;
}

function chainLocateAll(
  items: readonly TextItemRect[],
  needle: string,
  minFoldedOffset = 0,
  maxMatches = 8,
): number[][] {
  if (items.length > CHAIN_MAX_ITEMS) return [];
  const page = foldItems(items);
  const parts = page.parts;
  const layout = layoutOf(items, parts);
  let visits = 0;

  const continues = (j: number, rest: string) => {
    const part = parts[j]!;
    return part.length > 0 && (rest.startsWith(part) || part.startsWith(rest));
  };

  const successors = (from: number, rest: string, used: ReadonlySet<number>): number[] => {
    const r = layout.right[from]!;
    // An immediate word/run on the same line (`g < 1.5 * height`) cannot be
    // skipped over onto the next line without omitting words from the quote.
    if (r >= 0) return !used.has(r) && continues(r, rest) ? [r] : [];
    const found: Array<{ j: number; score: number }> = [];
    for (let j = 0; j < parts.length; j += 1) {
      if (used.has(j) || !continues(j, rest)) continue;
      const score = nextScore(items, layout, from, j);
      if (score !== null) found.push({ j, score });
    }
    return found.sort((p, q) => p.score - q.score).map((f) => f.j);
  };

  const extend = (from: number, consumed: number, path: number[], used: Set<number>): boolean => {
    if (consumed >= needle.length) return true;
    if (path.length >= MAX_QUOTE_ITEMS || visits > CHAIN_VISIT_BUDGET) return false;
    const rest = needle.slice(consumed);
    for (const j of successors(from, rest, used)) {
      visits += 1;
      path.push(j);
      used.add(j);
      if (extend(j, consumed + Math.min(parts[j]!.length, rest.length), path, used)) return true;
      path.pop();
      used.delete(j);
    }
    return false;
  };

  const out: number[][] = [];
  for (let i = 0; i < parts.length; i += 1) {
    if ((page.runEnd[i] ?? 0) <= minFoldedOffset) continue;
    const part = parts[i]!;
    for (let offset = Math.max(0, part.length - needle.length + 1); offset < part.length; offset += 1) {
      const globalOffset = (page.runStart[i] ?? 0) + offset;
      if (globalOffset < minFoldedOffset) continue;
      const tail = part.slice(offset);
      if (!needle.startsWith(tail)) continue;
      const path = [i];
      if (extend(i, tail.length, path, new Set(path))) {
        out.push([...path]);
        if (out.length >= maxMatches) return out;
        break;
      }
      if (visits > CHAIN_VISIT_BUDGET) return out;
    }
  }
  return out;
}

export function unionRect(rects: readonly PdfRect[]): PdfRect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
