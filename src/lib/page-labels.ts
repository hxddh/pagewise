/**
 * The number printed on the page, as opposed to the page's position in the file.
 *
 * A book's front matter is numbered i, ii, iii; its body restarts at 1. So the
 * page whose footer reads "47" is the 59th sheet, and every number the reader
 * says out loud is off by twelve from every number the app counts in. PageWise
 * had no notion of this at all: `read_pdf_page`'s own test says "Models cite
 * printed page numbers, which run ahead of physical ones" and then leaves the
 * model to guess the offset.
 *
 * PDF carries the answer — `/PageLabels`, surfaced by pdf.js as `getPageLabels`.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: put the mapping in the prompt. A
 * three-hundred-page document is three hundred labels, and sending them would
 * cost more per question than the pages the question is about. Resolution is
 * exact code here; the model is told one sentence and given a `label` argument
 * to pass through.
 */

/** Longest label kept. A label is a folio, not a sentence. */
const MAX_LABEL = 24;

/**
 * Labels worth carrying, or null.
 *
 * Null for the overwhelming majority of PDFs: most have no `/PageLabels` at
 * all, and of those that do, most number 1..n exactly as the file is ordered.
 * Both cases are indistinguishable from having no labels, and saying so lets
 * every caller downstream skip the whole mechanism rather than special-case it.
 */
export function normalizeLabels(
  raw: ReadonlyArray<string | null | undefined> | null | undefined,
  totalPages: number,
): string[] | null {
  if (!raw || raw.length === 0 || totalPages <= 0) return null;

  const out: string[] = [];
  let differs = false;
  for (let i = 0; i < totalPages; i += 1) {
    const label = (raw[i] ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
    // A page with no label of its own falls back to its position, so the array
    // is always total-length and callers never handle a hole.
    out.push(label || String(i + 1));
    if (out[i] !== String(i + 1)) differs = true;
  }
  return differs ? out : null;
}

/** What is printed on this 1-based page, or null when nothing useful is. */
export function labelForPage(labels: readonly string[] | null, page: number): string | null {
  if (!labels) return null;
  const label = labels[page - 1];
  if (!label || label === String(page)) return null;
  return label;
}

/**
 * The page a printed number refers to.
 *
 * Case- and space-insensitive, because a reader types "IV" for a page printed
 * "iv" and "A 3" for one printed "A-3". Separators are dropped for the same
 * reason.
 *
 * AMBIGUITY RESOLVES TO NOTHING. "1" can be both the twelfth sheet's printed
 * number and the first sheet's fallback; a document that restarts its numbering
 * per chapter can print "1" five times. Answering one of them at random would
 * send the reader somewhere confidently wrong, which is worse than saying the
 * number is not unique and letting the physical page stand.
 */
export function pageForLabel(labels: readonly string[] | null, label: string): number | null {
  if (!labels) return null;
  const needle = foldLabel(label);
  if (!needle) return null;
  let found = -1;
  for (let i = 0; i < labels.length; i += 1) {
    if (foldLabel(labels[i]!) !== needle) continue;
    if (found >= 0) return null;
    found = i;
  }
  return found >= 0 ? found + 1 : null;
}

function foldLabel(value: string): string {
  return value.toLowerCase().replace(/[\s._-]+/g, "");
}

/**
 * One sentence for the model: that printed numbers differ, and where.
 *
 * The first page whose label disagrees with its position is the whole story for
 * a normal book — front matter, then a restart — and it is enough for the model
 * to recognize that a number the reader says may be printed rather than
 * positional. It is NOT enough to do the arithmetic with, and is not meant to
 * be: `read_pdf_page` takes the printed number directly.
 */
export function describeLabels(labels: readonly string[] | null): string {
  if (!labels || labels.length === 0) return "";
  const first = labels.findIndex((l, i) => l !== String(i + 1));
  if (first < 0) return "";
  return (
    `Printed page numbers in this document do not match its physical order — ` +
    `sheet ${first + 1} is printed "${labels[first]}". When the reader cites a page ` +
    `number they read off the page, pass it to read_pdf_page as \`label\`; pass \`page\` ` +
    `only for a position you worked out yourself.`
  );
}
