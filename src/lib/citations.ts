/**
 * Citations in an answer: what the assistant says a page says, in its words.
 *
 * Until 13.0 the only citation an answer could carry was "page 12" — linked by
 * `remark-page-refs`, never checked, because there was nothing to check it
 * against. The record had verified quotes since 10.0, but the record is a side
 * panel; the answer is what a reader reads. So the answer now carries the
 * quote itself, inline, in a form this module can find:
 *
 *     逾期付款按日万分之三计息〔p5 "每逾期一日按逾期金额的万分之三"〕。
 *
 * The brackets are 〔 and 〕 (U+3014/U+3015): they almost never occur in prose
 * of either language, so a marker cannot be mistaken for text, and they are
 * easy for a model to produce and for a stream to recognise half-written.
 *
 * GRAMMAR. Inside the brackets, in order:
 *   - `d<n>` — a leading document handle, tolerated and ignored. 13.0 reserved
 *     it for citing across documents; that is no longer planned (13.1), and the
 *     prompt never asks for it. It stays accepted only so that a model which
 *     adds one anyway still gets its citation checked rather than shown raw.
 *   - `p<n>` or `p<n>-<m>` — the page or pages, by sheet number, the same
 *     numbering every reading tool uses.
 *   - a quote in "…", “…”, 「…」 or 『…』 — optional. Without one, the
 *     citation can only be followed, never checked.
 * Anything that does not parse is left as text: a reader sees exactly what the
 * model wrote rather than a silently dropped claim.
 */

export interface Citation {
  /** Every page the citation names, ascending. Never empty. */
  pages: number[];
  /** The quoted wording, or null when the model cited a page without one. */
  quote: string | null;
  /** The marker exactly as written, brackets included. */
  raw: string;
  /** Where the marker starts in the text it was read from. */
  index: number;
}

/** Most pages one citation may name; a wider range is not a citation of a passage. */
export const MAX_CITATION_PAGES = 5;

/** Longest quote kept. A "quote" longer than this is a pasted page, not a citation. */
export const MAX_CITATION_QUOTE = 600;

export const CITATION_OPEN = "〔";
export const CITATION_CLOSE = "〕";

/**
 * A fresh matcher for every complete marker in a string.
 *
 * A factory, not a shared `/g` constant: a global regex carries `lastIndex`
 * between uses, and one loop calling a helper that ran `replace` with the same
 * object had its position reset to 0 on every iteration — an infinite loop
 * that froze the app the first time an answer had a verified citation.
 */
export function citationRe(): RegExp {
  // Allow balanced inner `〔...〕` (such as Chinese statutory doc numbers `财税〔2024〕3号`)
  // inside quoted citation strings without breaking marker extraction (29.0).
  return /〔((?:[^〔〕\n]|〔[^〔〕\n]{1,40}〕){1,700})〕/g;
}

const PAGES_RE =
  /^(?:d\d+\s*)?(?:p|P|pp?\.?\s*)\s*(\d{1,5}(?:\s*(?:[-–—~]\s*\d{1,5}|,\s*(?:pp?\.?\s*)?\d{1,5}(?:\s*[-–—~]\s*\d{1,5})?))*)/;
const QUOTE_RE = /^["“「『'‘«]([\s\S]+)["”」』'’»]$/;

function parsePageSpec(spec: string): number[] | null {
  const seen = new Set<number>();
  for (const rawSeg of spec.split(",")) {
    const seg = rawSeg.trim().replace(/^(?:pp?\.?\s*)/i, "");
    const m = /^(\d{1,5})(?:\s*[-–—~]\s*(\d{1,5}))?$/.exec(seg);
    if (!m) return null;
    const a = parseInt(m[1]!, 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    if (!(a >= 1) || b < a || b - a + 1 > MAX_CITATION_PAGES) return null;
    for (let p = a; p <= b; p += 1) {
      seen.add(p);
      if (seen.size > MAX_CITATION_PAGES) return null;
    }
  }
  return seen.size > 0 ? [...seen].sort((x, y) => x - y) : null;
}

/** Parse the inside of one marker, or null when it is not a citation. */
export function parseCitation(inner: string): Omit<Citation, "raw" | "index"> | null {
  const text = inner.trim();
  const pages = PAGES_RE.exec(text);
  if (!pages) return null;
  const list = parsePageSpec(pages[1]!);
  if (!list) return null;

  const rest = text.slice(pages[0].length).trim().replace(/^[:：,，]\s*/, "");
  let quote: string | null = null;
  if (rest) {
    const q = QUOTE_RE.exec(rest);
    // Something after the page that is not a quote: not a form we promised to
    // read, so it is left as text rather than half-understood.
    if (!q) return null;
    quote = q[1]!.trim().slice(0, MAX_CITATION_QUOTE) || null;
  }
  return { pages: list, quote };
}

/** Every citation in a message, in order, duplicates included. */
export function extractCitations(markdown: string): Citation[] {
  const out: Citation[] = [];
  const re = citationRe();
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const parsed = parseCitation(m[1]!);
    if (parsed) out.push({ ...parsed, raw: m[0], index: m.index });
  }
  return out;
}

/** The key a citation's check is cached and looked up by. */
export function citationKey(c: Pick<Citation, "pages" | "quote">): string {
  return `${c.pages.join(",")} ${c.quote ?? ""}`;
}

/**
 * Hide a marker the stream has opened but not yet closed.
 *
 * `〔p12 "按日万` is half a citation: shown raw it flickers into a chip a moment
 * later, and if the stream stops there it is noise. The tail of a live answer
 * drops it until the closing bracket arrives.
 */
export function hideOpenCitation(text: string): string {
  const lineStart = text.lastIndexOf("\n") + 1;
  const line = text.slice(lineStart);
  if (!line.includes(CITATION_OPEN)) return text;

  // Walk the trailing line tracking bracket depth so nested statutory brackets
  // inside an open quote (`〔p3 "财税〔2024〕3`) still hide from the outer `〔p3`,
  // while balanced prose brackets (`财税〔2024〕3号`) stay visible (29.0).
  const stack: number[] = [];
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === CITATION_OPEN) {
      stack.push(lineStart + i);
    } else if (ch === CITATION_CLOSE && stack.length > 0) {
      stack.pop();
    }
  }
  if (stack.length === 0) return text;
  const outerUnclosed = stack[0]!;
  // Only hide if the unclosed `〔` looks like the start of a citation marker (`p`, `P`, `d`, or empty so far).
  const after = text.slice(outerUnclosed + 1).trimStart();
  if (after.length > 0 && !/^(?:d\d*\s*)?[pP\d]?/.test(after) && !/^[dpDP]/.test(after)) {
    return text;
  }
  return text.slice(0, outerUnclosed);
}

/** Sentence ends. A full stop between two digits is a decimal point, not an end (16.0). */
const SENTENCE_END = /(?<!\d)\.|\.(?!\d)|[!?。！？\n]/g;

const ABBREVIATION_BEFORE_DOT_RE =
  /(?:^|[\s(（[{["“'‘])(?:sec|art|fig|figs|eq|eqs|no|nos|vol|ch|chap|para|subpara|cl|dr|mr|mrs|ms|prof|sr|jr|st|vs|v|cf|viz|approx|ca|al|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|e\.g|i\.e)$/i;

/** True when `.` at `dotIndex` closes a standard title, section, or Latin abbreviation (`Sec. 4`, `e.g.`, `Dr. Lee`). */
export function isAbbreviationStop(text: string, dotIndex: number): boolean {
  if (text[dotIndex] !== ".") return false;
  const window = text.slice(Math.max(0, dotIndex - 12), dotIndex);
  if (ABBREVIATION_BEFORE_DOT_RE.test(window)) return true;
  // First dot in `e.g.` or `i.e.`
  if (/(?:^|[\s(（[{["“'‘])[ei]$/i.test(window) && /^[gi]\./i.test(text.slice(dotIndex + 1, dotIndex + 3))) {
    return true;
  }
  return false;
}

/**
 * The same rule as a fresh matcher, for a caller walking its own string — the
 * sentence table (`answer-sentences.ts`) splits by it, so a sentence there is
 * bounded by the same characters `sentenceBefore` treats as its start. A
 * factory, never a shared `/g` object: see `citationRe` for the freeze one
 * cost.
 */
export function sentenceEndRe(): RegExp {
  return new RegExp(SENTENCE_END.source, "g");
}
/** Stands in for an earlier marker when a claim starts after it. */
const MARKER_STOP = "\u0001";

/**
 * Where the text a citation stands behind starts in `cleaned`: just after the
 * last stop that is not its final character.
 */
function startAfterLastStop(cleaned: string, stops: RegExp): number {
  const last = cleaned.trimEnd().length - 1;
  let start = 0;
  let m: RegExpExecArray | null;
  stops.lastIndex = 0;
  while ((m = stops.exec(cleaned)) !== null) {
    if (cleaned[m.index] === "." && isAbbreviationStop(cleaned, m.index)) continue;
    if (m.index < last) start = m.index + m[0].length;
  }
  return start;
}

/**
 * List markers and headings are not words of the sentence; a number opening
 * it is ("36 months is the term"), so only a number followed by `.` `)` or `、`
 * and a space counts as a list marker.
 */
function withoutLeadingMarkers(s: string): string {
  let out = s.replace(/^\s+/, "");
  for (;;) {
    const next = out.replace(/^(?:[>#*+\-]+|\d+[.)、])\s+/, "");
    if (next === out) return out;
    out = next;
  }
}

function tidy(s: string): string {
  return withoutLeadingMarkers(s).replace(/\*\*|__|`/g, "").trim();
}

/**
 * The sentence a citation stands behind: the text from the previous sentence
 * end up to the marker. Used to keep a verified sentence as a record entry.
 */
export function sentenceBefore(markdown: string, markerIndex: number): string {
  // Earlier markers are not part of this sentence's words.
  const cleaned = markdown.slice(0, markerIndex).replace(citationRe(), "");
  return tidy(cleaned.slice(startAfterLastStop(cleaned, SENTENCE_END)));
}

/**
 * What one citation is evidence for: like `sentenceBefore`, but starting after
 * an earlier marker in the same sentence (16.0). In "the deposit is 30%〔p2〕
 * and the balance 70%〔p3〕", page 3 stands behind the balance, not the
 * deposit — checking 30% against it would flag a correct sentence. Markers
 * side by side stand behind the same words.
 */
function findCitationClose(markdown: string, openPos: number): number {
  let depth = 0;
  for (let i = openPos; i < markdown.length; i += 1) {
    const ch = markdown[i];
    if (ch === "\n") return -1;
    if (ch === CITATION_OPEN) depth += 1;
    else if (ch === CITATION_CLOSE) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function claimSpanBefore(markdown: string, markerIndex: number): string {
  const cleaned = markdown
    .slice(0, markerIndex)
    .replace(citationRe(), MARKER_STOP)
    .replace(new RegExp(`${MARKER_STOP}(?:[ \\t]*${MARKER_STOP})+`, "g"), MARKER_STOP);
  const stops = new RegExp(`${SENTENCE_END.source}|${MARKER_STOP}`, "g");
  const head = tidy(cleaned.slice(startAfterLastStop(cleaned, stops)).split(MARKER_STOP).join(""));

  // Include trailing text in the SAME sentence only when no later citation
  // marker appears before the sentence ends — closing the mid-sentence marker
  // loophole (`According to §4〔p5 "..."〕, the fee is 25%.`) while keeping
  // multi-marker sentences partitioned cleanly per marker.
  const closeAt = findCitationClose(markdown, markerIndex);
  if (closeAt < 0) return head;
  let afterPos = closeAt + 1;
  for (;;) {
    const ws = /^\s*/.exec(markdown.slice(afterPos))?.[0].length ?? 0;
    if (markdown[afterPos + ws] !== CITATION_OPEN) break;
    const nextClose = findCitationClose(markdown, afterPos + ws);
    if (nextClose < 0) break;
    if (!parseCitation(markdown.slice(afterPos + ws + 1, nextClose))) break;
    afterPos = nextClose + 1;
  }
  let endPos = markdown.length;
  const endRe = sentenceEndRe();
  endRe.lastIndex = afterPos;
  let em: RegExpExecArray | null;
  while ((em = endRe.exec(markdown)) !== null) {
    if (markdown[em.index] === "." && isAbbreviationStop(markdown, em.index)) continue;
    const beforeStop = markdown.slice(afterPos, em.index);
    const lastOpen = beforeStop.lastIndexOf(CITATION_OPEN);
    if (lastOpen >= 0 && !beforeStop.slice(lastOpen).includes(CITATION_CLOSE)) continue;
    endPos = em.index;
    break;
  }
  const tailSlice = markdown.slice(afterPos, endPos);
  if (extractCitations(tailSlice).length > 0) return head;
  const tail = tidy(tailSlice);
  if (!tail) return head;
  return head ? `${head} ${tail}` : tail;
}

/**
 * An answer's markers as plain prose, for text that leaves the app — a copied
 * answer, an exported conversation or brief. The quote stays: outside the app
 * it is the only way to find the passage again.
 */
export function citationsToText(markdown: string): string {
  return markdown.replace(citationRe(), (whole, inner: string) => {
    const c = parseCitation(inner);
    if (!c) return whole;
    const first = c.pages[0]!;
    const last = c.pages[c.pages.length - 1]!;
    const contiguous = last - first + 1 === c.pages.length;
    const pages =
      c.pages.length > 1
        ? contiguous
          ? `pp. ${first}–${last}`
          : `pp. ${c.pages.join(", ")}`
        : `p. ${first}`;
    return c.quote ? ` [${pages}: “${c.quote}”]` : ` [${pages}]`;
  });
}

/** An answer with its markers removed — for a one-line claim, where they are noise. */
export function stripCitations(markdown: string): string {
  return markdown.replace(citationRe(), (whole, inner: string) => (parseCitation(inner) ? "" : whole));
}
