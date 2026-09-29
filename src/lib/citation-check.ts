/**
 * Whether a citation in an answer is on the page it names.
 *
 * The same check the record has run on findings since 10.0 — `locateQuote`
 * against the page's own text runs, fetched once per page through `pageRuns` —
 * now run on every citation in every answer. Local, deterministic, and no
 * model call: the page either carries the words or it does not.
 *
 * THE STATES, AND THE ONE THAT MUST NEVER BE WRONG. `unlocated` tells a reader
 * that the assistant quoted words its page does not have. 12.0 found that
 * sentence being said about every scanned page, because a page with no text
 * layer was searched as an empty list. So it is said only when every named
 * page was read, had text, and lacked the words; a page that could not be
 * read makes the citation `unreadable` instead — unchecked, not doubted.
 *
 * Results are cached per document and page and quote, and cleared with the
 * page runs when the document changes, so a synchronous reader — the note
 * built at send time that tells the model which of its citations failed — can
 * read what the chips already worked out without waiting on IPC.
 */
import { pageRuns } from "./finding-anchors";
import { locateQuote } from "./quote-locate";
import {
  citationRe,
  citationKey,
  extractCitations,
  parseCitation,
  sentenceBefore,
  type Citation,
} from "./citations";
import type { PdfRect } from "./types";
import { rowAt, rowClaim } from "./answer-tables";

export type CitationStatus =
  /** The quoted words are on a page the citation names. */
  | "located"
  /** Every named page has text, and none of them has these words. */
  | "unlocated"
  /** A named page has no text layer, or could not be read. Unchecked, not doubted. */
  | "unreadable"
  /**
   * Not among the words OCR recognised on a named scanned page (14.0). OCR
   * misreads, so this is not `unlocated`: the reader is asked to look, and the
   * model is not told its citation failed.
   */
  | "unconfirmed"
  /** No quote, or one too short to mean anything: a page to turn to, not a claim to check. */
  | "unchecked"
  /** Names a page the document does not have. */
  | "outOfRange";

export interface CitationCheck {
  status: CitationStatus;
  /** Where the words were found. Only for `located`. */
  page?: number;
  /** One rectangle per text run the quote spans, bottom-left origin. Only for `located`. */
  rects?: PdfRect[];
}

const results = new Map<string, CitationCheck>();
/** Checks that came back `unreadable` because a read failed rather than because the page has no text. */
const transient = new Set<string>();
const pending = new Map<string, Promise<CitationCheck>>();

function key(path: string, c: Pick<Citation, "pages" | "quote">): string {
  return `${path}\n${citationKey(c)}`;
}

/** Forget every check. Called with `clearFindingAnchors`, when the open document changes. */
export function clearCitationChecks(path?: string): void {
  if (path === undefined) {
    results.clear();
    pending.clear();
    transient.clear();
    return;
  }
  const prefix = `${path}\n`;
  for (const k of [...results.keys()]) if (k.startsWith(prefix)) results.delete(k);
  for (const k of [...transient]) if (k.startsWith(prefix)) transient.delete(k);
  for (const k of [...pending.keys()]) if (k.startsWith(prefix)) pending.delete(k);
}

/** The check already worked out for this citation, or null if nobody has asked yet. */
export function cachedCitationCheck(
  path: string,
  c: Pick<Citation, "pages" | "quote">,
): CitationCheck | null {
  return results.get(key(path, c)) ?? null;
}

/** Check one citation against the document at `path`, which has `totalPages` pages. */
export function checkCitation(
  path: string,
  totalPages: number,
  c: Pick<Citation, "pages" | "quote">,
): Promise<CitationCheck> {
  const k = key(path, c);
  const done = results.get(k);
  if (done && !transient.has(k)) return Promise.resolve(done);
  const inFlight = pending.get(k);
  if (inFlight) return inFlight;
  const job: Promise<CitationCheck> = resolve(path, totalPages, c).then(({ check, failedRead }) => {
    if (pending.get(k) === job) {
      pending.delete(k);
      results.set(k, check);
      // A failed read may succeed next time; asking again re-checks it.
      if (failedRead) transient.add(k);
      else transient.delete(k);
    }
    return check;
  });
  pending.set(k, job);
  return job;
}

async function resolve(
  path: string,
  totalPages: number,
  c: Pick<Citation, "pages" | "quote">,
): Promise<{ check: CitationCheck; failedRead: boolean }> {
  const settled = (check: CitationCheck) => ({ check, failedRead: false });
  if (totalPages > 0 && c.pages.some((p) => p > totalPages)) return settled({ status: "outOfRange" });
  if (!c.quote) return settled({ status: "unchecked" });

  let sawAbsent = false;
  let sawUnreadable = false;
  let sawRecognised = false;
  let failedRead = false;
  for (const page of c.pages) {
    const runs = await pageRuns(path, page);
    if (runs.reason === "failed") {
      sawUnreadable = true;
      failedRead = true;
      continue;
    }
    const outcome = locateQuote(runs.items, c.quote);
    if (outcome.status === "located") return settled({ status: "located", page, rects: outcome.rects });
    if (outcome.status === "uncheckable") return settled({ status: "unchecked" });
    if (outcome.status === "unreadable") sawUnreadable = true;
    if (outcome.status === "absent") {
      sawAbsent = true;
      if (runs.source === "ocr") sawRecognised = true;
    }
  }
  // One page that could not be read is enough to withhold the accusation.
  if (sawUnreadable) return { check: { status: "unreadable" }, failedRead };
  // So is one page whose only words are OCR's reading of it.
  if (sawRecognised) return settled({ status: "unconfirmed" });
  return settled({ status: sawAbsent ? "unlocated" : "unchecked" });
}

export interface CitationTally {
  total: number;
  located: number;
  unlocated: number;
  unreadable: number;
  unconfirmed: number;
  unchecked: number;
  outOfRange: number;
  /** Not resolved yet. */
  pending: number;
}

export function emptyTally(): CitationTally {
  return {
    total: 0,
    located: 0,
    unlocated: 0,
    unreadable: 0,
    unconfirmed: 0,
    unchecked: 0,
    outOfRange: 0,
    pending: 0,
  };
}

/** Count one answer's citations by what is known about them right now. */
export function tallyCitations(path: string, markdown: string): CitationTally {
  const tally = emptyTally();
  const seen = new Set<string>();
  for (const c of extractCitations(markdown)) {
    const k = citationKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    tally.total += 1;
    const check = cachedCitationCheck(path, c);
    if (!check) tally.pending += 1;
    else tally[check.status] += 1;
  }
  return tally;
}

/** Check every citation in an answer; resolves when all are known. */
export async function checkAnswer(path: string, totalPages: number, markdown: string): Promise<CitationTally> {
  await Promise.all(
    extractCitations(markdown).map((c) => checkCitation(path, totalPages, c).catch(() => null)),
  );
  return tallyCitations(path, markdown);
}

/** A sentence of an answer whose citation was found on its page. */
export interface VerifiedSentence {
  claim: string;
  page: number;
  quote: string;
}

/**
 * The sentences of an answer that carry a located citation, each with the
 * page and the words that confirm it. What "keep the verified sentences"
 * writes to the record: each becomes an entry whose evidence is already known
 * to be on its page, so it arrives in the record as *found on page N* rather
 * than as a claim to be checked.
 */
export function verifiedSentences(path: string, markdown: string): VerifiedSentence[] {
  const out: VerifiedSentence[] = [];
  const seen = new Set<string>();
  const re = citationRe();
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const c = parseCitation(m[1]!);
    if (!c?.quote) continue;
    const check = cachedCitationCheck(path, c);
    if (check?.status !== "located" || !check.page) continue;
    // A citation in a table cell supports its row, not the text before the
    // marker — which, in a table, is a run of cells from the row above.
    const inRow = rowAt(markdown, m.index);
    // And a row is only as verified as its least-verified cell: keeping it
    // would put every value in it into the record.
    if (
      inRow &&
      inRow.row.cells
        .flatMap((cell) => extractCitations(cell))
        .some((rc) => rc.quote && cachedCitationCheck(path, rc)?.status !== "located")
    ) {
      continue;
    }
    const claim = inRow ? rowClaim(inRow.table, inRow.row) : sentenceBefore(markdown, m.index);
    if (!claim || seen.has(claim)) continue;
    seen.add(claim);
    out.push({ claim, page: check.page, quote: c.quote });
  }
  return out;
}
