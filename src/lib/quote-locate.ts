/**
 * Where on the page a quoted passage actually is.
 *
 * The assistant never sees a coordinate. Every one of the eight document tools
 * is text in, text out, and `finding-store.ts` wrote that down as a limit —
 * "the agent has no coordinates: it never sees the page as a picture. Pinning a
 * claim to a rectangle it did not choose would be an invented anchor" — while
 * `RecordPanel.tsx` concluded from the same premise that findings could never
 * be drawn beside the text they came from.
 *
 * The premise is right and the conclusion does not follow. The agent does not
 * have to supply a rectangle: it supplies the words, and we find them. The
 * anchor is derived here, locally, from `page_text_items` — the same command
 * the reader's own marks already round-trip through. Nothing is trusted that
 * the page itself does not confirm.
 *
 * WHICH MAKES THE FAILURE THE VALUABLE HALF. A quote that cannot be found on
 * the page it was attributed to is a quote that is not there. That check is
 * deterministic, local, and costs no model call — and for a reader whose whole
 * reason to use this is that the assistant's citation is really on the page,
 * catching a fabricated one is worth more than drawing a true one prettily.
 *
 * WHITESPACE IS DISCARDED ENTIRELY, on both sides. Runs reported by the
 * extractor are lines, so any quote longer than a line arrives split across
 * several of them — `matchingItems` in search-highlight.ts matches within a
 * single run and says so ("a phrase broken across two lines matches neither").
 * Joining runs with a space instead would break CJK, where a line break is not
 * a word boundary and inserting one puts a space in the middle of a sentence
 * the quote does not have. Dropping whitespace from both haystack and needle
 * handles wrapped English and wrapped Chinese with the same rule.
 *
 * HYPHENS AND DASHES ARE DROPPED TOO, since 12.0. A word hyphenated across a
 * line break — "reve-\nnue" — kept its hyphen and never matched "revenue", and
 * the 11.0 review counted that among the ways a true citation was reported as
 * not on its page. Dropping every hyphen and dash from both sides is symmetric
 * and cannot create a match that the words themselves do not support: "re-enter"
 * and "reenter" fold the same, and nothing else does.
 */
import type { PdfRect, TextItemRect } from "./types";

/**
 * Shortest quote that may be located.
 *
 * Below this a match means nothing: four characters occur on almost every page,
 * so both "found" and "not found" would be noise, and the second is the one
 * that gets shown to a reader as doubt about a citation. Short quotes are
 * reported as uncheckable instead — see `LocateOutcome`.
 */
export const MIN_QUOTE_CHARS = 6;

/** Most runs one quote may span. A quote covering more is not one passage. */
export const MAX_QUOTE_ITEMS = 40;

export type LocateOutcome =
  /** Found: these runs carry it, in document order. */
  | { status: "located"; items: TextItemRect[]; rects: PdfRect[] }
  /** Looked for it on the page it was attributed to; it is not there. */
  | { status: "absent" }
  /** Too short, or nothing to look for. Neither confirmed nor doubted. */
  | { status: "uncheckable" }
  /**
   * The page has no text to look in. A scanned page, or one whose runs could
   * not be read. Nothing was confirmed and nothing was doubted — until 12.0
   * this was reported as `absent`, which told the reader a true citation was
   * not on the page.
   */
  | { status: "unreadable" };

/** Whitespace, plus the hyphens and dashes a line break can introduce. */
const DROPPED = /[\s\-\u00AD\u2010\u2011\u2012\u2013\u2014]/;

/**
 * Quotation marks of every style, since 13.0. A model copying `the filter’s
 * benefit` writes `the filter's benefit` more often than not, and a Chinese
 * answer may wrap a phrase in 「」 where the page has “”. The quote marks are
 * not the words; dropping them from both sides cannot make two different
 * passages equal. The grave accent is here because plain-text documents open
 * a quotation with it (`show w').
 */
const QUOTE_MARKS = /['"`\u00B4\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\u2032\u2033\u300C\u300D\u300E\u300F\uFF02\uFF07]/;

/**
 * Case-fold and drop whitespace, recording where each surviving character came
 * from.
 *
 * Folded per code point rather than with one `toLowerCase` over the whole
 * string: that call can change length — U+0130 "İ" folds to "i" plus a
 * combining dot — which desyncs every offset after it from its source. The same
 * trap `document-search.ts` documents, and the same fix.
 */
function fold(text: string): { folded: string; source: number[] } {
  let folded = "";
  const source: number[] = [];
  let offset = 0;
  for (const ch of text) {
    const width = ch.length;
    // NFKC per code point, since 13.0: a ligature on the page ("ﬁ") and the
    // letters a model types for it, full-width and half-width punctuation,
    // "…" and "..." — each pair folds to one spelling. Compatibility forms
    // only ever map to what they are a presentation of, so this widens what
    // counts as the same text and never what counts as a match.
    for (const unit of ch.normalize("NFKC").toLowerCase()) {
      if (DROPPED.test(unit) || QUOTE_MARKS.test(unit)) continue;
      folded += unit;
      source.push(offset);
    }
    offset += width;
  }
  return { folded, source };
}

/** The whole page as one folded string, plus which run each character is in. */
function foldItems(items: readonly TextItemRect[]): { folded: string; itemAt: number[] } {
  let folded = "";
  const itemAt: number[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const { folded: part } = fold(items[i]!.text.normalize("NFC"));
    folded += part;
    for (let k = 0; k < part.length; k += 1) itemAt.push(i);
  }
  return { folded, itemAt };
}

/**
 * Find a quote among a page's text runs.
 *
 * `items` must be the runs of the page the quote was attributed to. Searching
 * the whole document instead would turn "this claim cites the wrong page" into
 * a highlight somewhere else, which is precisely the error worth catching.
 */
export function locateQuote(items: readonly TextItemRect[], quote: string): LocateOutcome {
  const { folded: needle } = fold((quote ?? "").normalize("NFC"));
  if (needle.length < MIN_QUOTE_CHARS) return { status: "uncheckable" };
  if (items.length === 0) return { status: "unreadable" };

  const { folded, itemAt } = foldItems(items);
  const at = folded.indexOf(needle);
  if (at >= 0) {
    // Runs in the order the extractor listed them. That order is wrong across
    // the gutter of a two-column page, but a quote that matches only by
    // reading across the gutter is not one the model can have copied — the
    // page text it reads is in column order — and requiring reading order
    // here cost a real document a third of its true matches: table cells and
    // centred title lines look exactly like columns. See the 13.0 notes in
    // `eval/location.eval.ts`.
    const first = itemAt[at]!;
    const last = itemAt[at + needle.length - 1]!;
    const span = items.slice(first, Math.min(last + 1, first + MAX_QUOTE_ITEMS));
    return { status: "located", items: span, rects: span.map((item) => item.rect) };
  }

  const chain = chainLocate(items, needle);
  if (!chain) return { status: "absent" };
  const span = chain.map((i) => items[i]!);
  return { status: "located", items: span, rects: span.map((item) => item.rect) };
}

/** Most runs `chainLocate` will visit for one quote, so a pathological page stays cheap. */
const CHAIN_VISIT_BUDGET = 20_000;

/** Above this many runs on one page the layout pass is skipped and only the fast path runs. */
const CHAIN_MAX_ITEMS = 2_500;

/**
 * Where each run sits in the reading order of its page.
 *
 * Runs on one line are neighbours when the gap between them is under 1.5
 * line heights: wider than any word space justification produces, narrower
 * than a column gutter. That single threshold is what tells "the next word"
 * from "the other column".
 */
interface Layout {
  /** The run immediately to the right on the same line, or -1 at a line's end. */
  right: number[];
  /** Whether nothing sits immediately to the left: the run starts a line (in its column). */
  lineStart: boolean[];
  /** x of the first run of the line segment this run is on. */
  segLeft: number[];
  /** Whether a line continues below this run's line in the same column. */
  hasLineBelow: boolean[];
}

function sameLine(a: PdfRect, b: PdfRect): boolean {
  return Math.abs(a.y - b.y) < Math.max(a.height, b.height) * 0.6;
}

function layoutOf(items: readonly TextItemRect[]): Layout {
  const n = items.length;
  const right = new Array<number>(n).fill(-1);
  const left = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i += 1) {
    const a = items[i]!.rect;
    const gap = Math.max(a.height, 1) * 1.5;
    let best = -1;
    let bestGap = Infinity;
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      const b = items[j]!.rect;
      if (!sameLine(a, b)) continue;
      const g = b.x - (a.x + a.width);
      if (g > -a.height * 0.5 && g < gap && b.x > a.x && g < bestGap) {
        best = j;
        bestGap = g;
      }
    }
    right[i] = best;
    if (best >= 0 && left[best] < 0) left[best] = i;
  }
  const segLeft = items.map((item, i) => {
    let k = i;
    for (let guard = 0; left[k]! >= 0 && guard < n; guard += 1) k = left[k]!;
    return k === i ? item.rect.x : items[k]!.rect.x;
  });
  const layout: Layout = { right, lineStart: left.map((l) => l < 0), segLeft, hasLineBelow: [] };
  layout.hasLineBelow = items.map((_, i) => items.some((__, j) => j !== i && isLineBelow(items, layout, i, j)));
  return layout;
}

/**
 * How plausibly run `b` is read straight after run `a` — lower is likelier —
 * or null when it cannot be. See `chainLocate` for why the rule is this narrow.
 */
function nextScore(items: readonly TextItemRect[], layout: Layout, a: number, b: number): number | null {
  const r = layout.right[a]!;
  if (r >= 0) return r === b ? 0 : null;
  if (!layout.lineStart[b]) return null;
  const ra = items[a]!.rect;
  const rb = items[b]!.rect;
  // Bottom-left origin: a line below has a smaller y.
  if (isLineBelow(items, layout, a, b)) return ra.y - rb.y;
  // Off the foot of one column onto the head of the next: only upward and to
  // the right, and only when this column has no line below to go to instead.
  if (rb.x >= ra.x + ra.width && rb.y > ra.y && !sameLine(ra, rb) && !layout.hasLineBelow[a]) {
    return 10_000 - rb.y;
  }
  return null;
}

/** Whether `b` starts the line directly below `a`'s line, in the same column. */
function isLineBelow(items: readonly TextItemRect[], layout: Layout, a: number, b: number): boolean {
  if (!layout.lineStart[b]) return false;
  const ra = items[a]!.rect;
  const rb = items[b]!.rect;
  const h = Math.max(ra.height, rb.height, 1);
  const drop = ra.y - rb.y;
  return drop > h * 0.4 && drop < h * 3.2 && Math.abs(rb.x - layout.segLeft[a]!) < h * 4;
}

/**
 * Find a quote as a chain of runs, following the page's reading order.
 *
 * WHY THE FAST PATH IS NOT ENOUGH. `page_text_items` lists runs top to bottom
 * across the whole page. On a two-column page that interleaves the columns
 * line by line — left line, right line, left line — so the page read as one
 * string is not the page as anyone reads it, and a sentence that wraps inside
 * the left column is broken by the right column's lines. Measured on the 13.0
 * evaluation corpus: verbatim quotes from the two two-column documents were
 * found 40% of the time, against 98–99% for single-column ones.
 *
 * So this follows the words instead: a quote is a run's tail, then whole runs,
 * then a run's head, each run continuing exactly where the last one stopped.
 *
 * AND WHY THE NEXT RUN IS SO NARROWLY CHOSEN. Justified lines are often split
 * into one run per word. If any run that happened to continue the quote were
 * allowed next, "most real traces" would chain as "real most traces" — the
 * first version of this did exactly that, and located 6% of deliberately
 * altered quotes. The next run must be the one a reader reads next: the
 * immediate right-hand neighbour on the same line; or, at a line's end, the
 * start of a line just below, in the same column; or, failing both, the start
 * of a line in a column further right (a quote that runs off the bottom of one
 * column onto the top of the next).
 *
 * Returns the chain's run indices in reading order, or null.
 */
function chainLocate(items: readonly TextItemRect[], needle: string): number[] | null {
  if (items.length > CHAIN_MAX_ITEMS) return null;
  const parts = items.map((item) => fold(item.text.normalize("NFC")).folded);
  const layout = layoutOf(items);
  let visits = 0;

  const continues = (j: number, rest: string) => {
    const part = parts[j]!;
    return part.length > 0 && (rest.startsWith(part) || part.startsWith(rest));
  };

  /** Runs that read next after `from` and could carry `rest`, best first. */
  const successors = (from: number, rest: string, used: ReadonlySet<number>): number[] => {
    const r = layout.right[from]!;
    // Mid-line, the only way on is the neighbour to the right.
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

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    // Where in this run could the quote begin, such that the run's whole tail
    // is the quote's opening? A quote wholly inside one run was the fast path.
    for (let offset = Math.max(0, part.length - needle.length + 1); offset < part.length; offset += 1) {
      const tail = part.slice(offset);
      if (!needle.startsWith(tail)) continue;
      const path = [i];
      if (extend(i, tail.length, path, new Set(path))) return path;
      if (visits > CHAIN_VISIT_BUDGET) return null;
    }
  }
  return null;
}

/**
 * The union of a located quote's runs, as one rectangle in PDF points.
 *
 * Used to place a margin note beside the passage rather than to draw over it:
 * the individual runs are what gets underlined, and the union is where the note
 * points. Bottom-left origin throughout, because that is what `page_text_items`
 * reports — see `pdfRectToBox` versus `topLeftRectToBox`, and 9.2.3 for what
 * confusing the two costs.
 */
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
