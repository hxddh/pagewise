/**
 * What goes in the page's outer margin, and in what order.
 *
 * The margin is where a mark, a conclusion and the answer that talked about the
 * page all become visible at once — the three inks the app already draws on the
 * paper (yellow, violet) plus the accent for a turn that cited it. 19.0 moved
 * marks out of the sidebar and into this margin; 20.0 turned it into the
 * margin column: while the panel is closed the entries carry their words, so a
 * short answer and its sentence states sit beside the page they are about and
 * the panel does not have to open for the common case.
 *
 * TWO READINGS OF THE SAME MARGIN. With the panel open the margin is dots —
 * one per mark, finding and citing answer — because the reader has already
 * bought those entries in the panel; with it closed the margin is the column.
 * Both read the same sources; `gutterEntries` is the dots' list and
 * `columnEntries` the column's.
 *
 * WHO STAYS IN THE COLUMN, WHO GOES TO THE RECORD. The column holds, per page,
 * up to `MAX_MARGIN_ENTRIES` of each kind: the sentences of answers that cite
 * the page (each with its state), the findings placed on it, the reader's own
 * marks. Everything past those caps, and everything struck or superseded, is
 * the record panel's — it is the ledger, and the margin is the page. The whole
 * answer is never the column's: a sentence is the unit of a check (20.0) and
 * of the margin, and the full prose stays in the panel, one click away.
 *
 * Read synchronously from the stores, like the two layers: the caller bumps a
 * `revision` when the document's record changes and this re-reads. No geometry
 * is computed here — where an entry sits is the scroller's business
 * (`page-layout.ts`) and the column's rule (`columnTops`).
 */
import { getMarks, type Mark } from "../../lib/mark-store";
import {
  findingsOnPage,
  getFindings,
  isSuperseded,
  type Finding,
} from "../../lib/finding-store";
import type { AnswerNote, PageCitation } from "../../lib/page-citations";
import type { Citation } from "../../lib/citations";
import type { SentenceReason, SentenceState } from "../../lib/answer-sentences";

export type GutterKind = "mark" | "finding" | "answer";

export interface GutterEntry {
  kind: GutterKind;
  /** The mark, finding or message this entry stands for. */
  id: string;
  /** The short note a hover shows. */
  note: string;
  /** Marks: true when `note` is the reader's own words, false for highlighted
   *  text — the same distinction `MarkLayer` makes for the on-page mark. */
  fromNote?: boolean;
  /** 1-based page the entry belongs to. */
  page: number;
  /** The words the column draws (20.0): a mark's text or note, a finding's
   *  claim, the sentence of an answer that cited this page. */
  text: string;
  /** Answers: the state of the sentence, in the five of `answer-sentences.ts`. */
  state?: SentenceState;
  /** Answers: what put the sentence in its state — the worst marker's reason. */
  reason?: SentenceReason;
  /** Answers: for a `mismatch`, the numbers the passage does not state. */
  unstated?: string[];
  /** Answers: the markers behind the sentence, for the title and the anchor. */
  citations?: Citation[];
}

/**
 * Most entries of one kind the margin draws for one page — as dots while the
 * panel is open, as cards while it is closed.
 *
 * Past this the strip runs down the margin faster than the eye can use it, and
 * the list that holds everything is the record panel's. The same argument
 * `FindingLayer` makes for its margin tabs.
 */
export const MAX_MARGIN_ENTRIES = 12;

/**
 * The smallest distance two cards in the column may sit apart, as a fraction
 * of the page's height (20.0).
 *
 * Every entry belongs beside the passage it is about; two about the same
 * paragraph would be drawn on top of each other. One step is about a three-line
 * card at a page height of ~1,000px — the height a card is allowed to grow to
 * (`max-height` in the stylesheet).
 */
export const COLUMN_MIN_STEP = 0.06;

/**
 * Where each column entry sits, as a fraction of the page's height.
 *
 * Entries keep the anchor they came with — the passage's own place on the page
 * — unless that would draw them over the entry before them, in which case they
 * are pushed just below it. An entry with no anchor (a quote that was not
 * found, a check still running) starts at the top of the page, where it is at
 * least beside the page it is about. The result is parallel to the input, so
 * the caller's order — and the DOM's — is its own business.
 */
export function columnTops(tops: ReadonlyArray<number | undefined>): number[] {
  const order = tops
    .map((top, i) => ({ i, top: top ?? 0 }))
    .sort((a, b) => a.top - b.top || a.i - b.i);
  const out = new Array<number>(tops.length).fill(0);
  let floor = 0;
  for (const { i, top } of order) {
    const placed = Math.max(top, floor);
    out[i] = placed;
    floor = placed + COLUMN_MIN_STEP;
  }
  return out;
}

/** Marks on this page, as margin entries — the reader's own ink. */
function markEntries(path: string, page: number): GutterEntry[] {
  const marks: Mark[] = getMarks(path).filter((m) => m.page === page);
  return marks.slice(0, MAX_MARGIN_ENTRIES).map((mark) => ({
    kind: "mark" as const,
    id: mark.id,
    note: mark.note || mark.text,
    fromNote: !!mark.note,
    page,
    text: mark.note || mark.text,
  }));
}

/** Findings on this page that still stand, as margin entries. */
function findingEntries(path: string, page: number): GutterEntry[] {
  const all = getFindings(path);
  const findings: Finding[] = findingsOnPage(path, page).filter(
    // Struck by the reader, or replaced by a later claim: both stay in the
    // record, where the history is the point; neither is drawn as though it
    // still stood. The same rule the finding layer applies to the page.
    (f) => !f.struck && !isSuperseded(all, f.id),
  );
  return findings.slice(0, MAX_MARGIN_ENTRIES).map((finding) => ({
    kind: "finding" as const,
    id: finding.id,
    note: finding.claim,
    page,
    text: finding.claim,
  }));
}

/**
 * The margin's dots for one page: marks first, then findings, then answers —
 * the reader's own ink, the assistant's conclusions, the conversation. Grouped
 * rather than interleaved so the three colours read as three kinds of thing.
 */
export function gutterEntries(
  path: string,
  page: number,
  citations?: Map<number, PageCitation[]> | null,
): GutterEntry[] {
  const out: GutterEntry[] = [...markEntries(path, page), ...findingEntries(path, page)];

  const cited = citations?.get(page) ?? [];
  for (const citation of cited.slice(0, MAX_MARGIN_ENTRIES)) {
    out.push({
      kind: "answer",
      id: citation.messageId,
      note: citation.quote ?? "",
      page,
      text: citation.quote ?? "",
    });
  }

  return out;
}

/**
 * The margin column's entries for one page (20.0): the same marks and
 * findings, and — in place of one entry per citing answer — one per *sentence*
 * of an answer that cites this page, carrying the state of its evidence.
 *
 * A sentence is the unit the checks produce and the unit a reader reads; an
 * answer with three sentences about this page is three entries, each of which
 * can be verified, doubted or unchecked on its own.
 */
export function columnEntries(
  path: string,
  page: number,
  notes?: Map<number, AnswerNote[]> | null,
): GutterEntry[] {
  const out: GutterEntry[] = [...markEntries(path, page), ...findingEntries(path, page)];
  const pageNotes = (notes?.get(page) ?? []).slice(0, MAX_MARGIN_ENTRIES);
  for (const note of pageNotes) {
    out.push({
      kind: "answer",
      id: note.messageId,
      note: note.text,
      page,
      text: note.text,
      state: note.state,
      reason: note.reason,
      ...(note.unstated ? { unstated: note.unstated } : {}),
      citations: note.citations,
    });
  }
  return out;
}
