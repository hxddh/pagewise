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
import { ocrEnabled } from "./ocr/ocr-service";
import { locateQuote } from "./quote-locate";
import {
  citationKey,
  extractCitations,
  sentenceBefore,
  type Citation,
} from "./citations";
import type { PdfRect } from "./types";
import { claimBefore, rowAt, rowClaim } from "./answer-tables";
import { passageAround } from "./passage";
import { unstatedQuantities } from "./quantities";

/**
 * A located check, read against the sentence it supports: `mismatch` when the
 * sentence states a number the passage around the quote does not (15.0).
 * Any other check comes back unchanged, and so does a located one whose
 * sentence has no numbers, or only numbers the passage states.
 */
export function withClaim(check: CitationCheck | null, claim: string, quote?: string | null): CitationCheck | null {
  if (!check || check.status !== "located" || !claim) return check;
  const context = `${check.passage ?? ""}\n${quote ?? ""}`;
  const unstated = unstatedQuantities(claim, context);
  if (unstated.length === 0) return check;
  return { ...check, status: "mismatch", unstated: unstated.map((q) => q.text) };
}

export type CitationStatus =
  /** The quoted words are on a page the citation names. */
  | "located"
  /** Every named page has text, and none of them has these words. */
  | "unlocated"
  /**
   * The quoted words are on the page, but a number in the sentence they
   * support is not in the passage they were found in (15.0). Found and
   * doubted at once: the reader is told which number.
   */
  | "mismatch"
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
  /** The paragraph the quote was found in, as page text. Only for `located`. */
  passage?: string;
  /** For `mismatch`: the sentence's numbers the passage does not state, as written. */
  unstated?: string[];
}

const results = new Map<string, CitationCheck>();
/** Checks that came back `unreadable` because a read failed rather than because the page has no text. */
const transient = new Set<string>();
/** Unreadable because a page had no words while OCR was off (16.0). */
const readWithoutOcr = new Set<string>();
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
    readWithoutOcr.clear();
    return;
  }
  const prefix = `${path}\n`;
  for (const k of [...results.keys()]) if (k.startsWith(prefix)) results.delete(k);
  for (const k of [...transient]) if (k.startsWith(prefix)) transient.delete(k);
  for (const k of [...readWithoutOcr]) if (k.startsWith(prefix)) readWithoutOcr.delete(k);
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
  // Unreadable while OCR was off: turning it on is what could make it readable.
  const stale = readWithoutOcr.has(k) && ocrEnabled();
  if (done && !transient.has(k) && !stale) return Promise.resolve(done);
  const inFlight = pending.get(k);
  if (inFlight) return inFlight;
  const job: Promise<CitationCheck> = resolve(path, totalPages, c).then(({ check, failedRead, emptyPage }) => {
    if (pending.get(k) === job) {
      pending.delete(k);
      results.set(k, check);
      // A failed read may succeed next time; asking again re-checks it. So
      // may a page with no words yet while OCR is on — it has not been read,
      // or its reading timed out (16.0, B10).
      if (failedRead || (emptyPage && ocrEnabled())) transient.add(k);
      else transient.delete(k);
      if (emptyPage && !ocrEnabled()) readWithoutOcr.add(k);
      else readWithoutOcr.delete(k);
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
): Promise<{ check: CitationCheck; failedRead: boolean; emptyPage?: boolean }> {
  const settled = (check: CitationCheck) => ({ check, failedRead: false });
  if (totalPages > 0 && c.pages.some((p) => p > totalPages)) return settled({ status: "outOfRange" });
  if (!c.quote) return settled({ status: "unchecked" });

  let sawAbsent = false;
  let sawUnreadable = false;
  let sawRecognised = false;
  let failedRead = false;
  let emptyPage = false;
  for (const page of c.pages) {
    const runs = await pageRuns(path, page);
    if (runs.reason === "failed") {
      sawUnreadable = true;
      failedRead = true;
      continue;
    }
    if (runs.items.length === 0) emptyPage = true;
    const outcome = locateQuote(runs.items, c.quote);
    if (outcome.status === "located") {
      const passage = passageAround(runs.items, outcome.rects);
      return settled({ status: "located", page, rects: outcome.rects, passage });
    }
    if (outcome.status === "uncheckable") return settled({ status: "unchecked" });
    if (outcome.status === "unreadable") sawUnreadable = true;
    if (outcome.status === "absent") {
      sawAbsent = true;
      if (runs.source === "ocr") sawRecognised = true;
    }
  }
  // One page that could not be read is enough to withhold the accusation.
  if (sawUnreadable) return { check: { status: "unreadable" }, failedRead, emptyPage };
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
  mismatch: number;
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
    mismatch: 0,
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
    const check = withClaim(cachedCitationCheck(path, c), claimBefore(markdown, c.index), c.quote);
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
  const all = extractCitations(markdown);
  // Located, and — since 15.0 — without a number the passage does not state.
  const holds = (c: Citation) =>
    withClaim(cachedCitationCheck(path, c), claimBefore(markdown, c.index), c.quote)?.status === "located";
  for (const c of all) {
    if (!c.quote || !holds(c)) continue;
    const check = cachedCitationCheck(path, c)!;
    if (!check.page) continue;
    // A citation in a table cell supports its row, not the text before the
    // marker — which, in a table, is a run of cells from the row above.
    const inRow = rowAt(markdown, c.index);
    // And a row is only as verified as its least-verified cell: keeping it
    // would put every value in it into the record.
    if (
      inRow &&
      all.some((rc) => rc.index >= inRow.row.start && rc.index <= inRow.row.end && rc.quote && !holds(rc))
    ) {
      continue;
    }
    const claim = inRow ? rowClaim(inRow.table, inRow.row) : sentenceBefore(markdown, c.index);
    if (!claim || seen.has(claim)) continue;
    seen.add(claim);
    out.push({ claim, page: check.page, quote: c.quote });
  }
  return out;
}
