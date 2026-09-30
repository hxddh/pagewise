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
  return /〔([^〔〕\n]{1,700})〕/g;
}

const PAGES_RE = /^(?:d\d+\s*)?(?:p|P|pp?\.?\s*)\s*(\d{1,5})(?:\s*[-–—~]\s*(\d{1,5}))?/;
const QUOTE_RE = /^["“「『'‘]([\s\S]+)["”」』'’]$/;

/** Parse the inside of one marker, or null when it is not a citation. */
export function parseCitation(inner: string): Omit<Citation, "raw" | "index"> | null {
  const text = inner.trim();
  const pages = PAGES_RE.exec(text);
  if (!pages) return null;
  const first = parseInt(pages[1]!, 10);
  const last = pages[2] ? parseInt(pages[2], 10) : first;
  if (!(first >= 1) || last < first || last - first + 1 > MAX_CITATION_PAGES) return null;

  const rest = text.slice(pages[0].length).trim().replace(/^[:：,，]\s*/, "");
  let quote: string | null = null;
  if (rest) {
    const q = QUOTE_RE.exec(rest);
    // Something after the page that is not a quote: not a form we promised to
    // read, so it is left as text rather than half-understood.
    if (!q) return null;
    quote = q[1]!.trim().slice(0, MAX_CITATION_QUOTE) || null;
  }
  const list: number[] = [];
  for (let p = first; p <= last; p += 1) list.push(p);
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
  const open = text.lastIndexOf(CITATION_OPEN);
  if (open < 0 || text.indexOf(CITATION_CLOSE, open) >= 0) return text;
  // A newline means the bracket was never a marker.
  if (text.slice(open).includes("\n")) return text;
  return text.slice(0, open);
}

/** Sentence ends. A full stop between two digits is a decimal point, not an end (16.0). */
const SENTENCE_END = /(?<!\d)\.|\.(?!\d)|[!?。！？\n]/g;
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
export function claimSpanBefore(markdown: string, markerIndex: number): string {
  const cleaned = markdown.slice(0, markerIndex).replace(citationRe(), MARKER_STOP);
  const stops = new RegExp(`${SENTENCE_END.source}|${MARKER_STOP}`, "g");
  return tidy(cleaned.slice(startAfterLastStop(cleaned, stops)).split(MARKER_STOP).join(""));
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
    const pages = c.pages.length > 1 ? `pp. ${c.pages[0]}–${c.pages[c.pages.length - 1]}` : `p. ${c.pages[0]}`;
    return c.quote ? ` [${pages}: “${c.quote}”]` : ` [${pages}]`;
  });
}

/** An answer with its markers removed — for a one-line claim, where they are noise. */
export function stripCitations(markdown: string): string {
  return markdown.replace(citationRe(), (whole, inner: string) => (parseCitation(inner) ? "" : whole));
}
