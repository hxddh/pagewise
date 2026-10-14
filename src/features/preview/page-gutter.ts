/**
 * What goes in the page's outer margin, and in what order.
 *
 * The margin is where a mark, a conclusion and the answer that talked about the
 * page all become visible at once — the three inks the app already draws on the
 * paper (yellow, violet) plus the accent for a turn that cited it. 19.0 moved
 * marks out of the sidebar and into this margin, so this module is the list the
 * gutter draws; the drawing is `PageGutter.tsx`.
 *
 * Read synchronously from the stores, like the two layers: the caller bumps a
 * `revision` when the document's record changes and this re-reads. No geometry
 * is computed here — a dot sits in the margin beside the page, and the page's
 * position is the scroller's business (`page-layout.ts`), not a second
 * coordinate system.
 */
import { getMarks, type Mark } from "../../lib/mark-store";
import {
  findingsOnPage,
  getFindings,
  isSuperseded,
  type Finding,
} from "../../lib/finding-store";
import type { PageCitation } from "../../lib/page-citations";

export type GutterKind = "mark" | "finding" | "answer";

export interface GutterEntry {
  kind: GutterKind;
  /** The mark, finding or message this dot stands for. */
  id: string;
  /** The short note a hover shows. */
  note: string;
  /** Marks: true when `note` is the reader's own words, false for highlighted
   *  text — the same distinction `MarkLayer` makes for the on-page mark. */
  fromNote?: boolean;
  /** 1-based page the dot belongs to. */
  page: number;
}

/**
 * Most dots of one kind drawn on one page.
 *
 * Past this the strip runs down the margin faster than the eye can use it, and
 * the list that holds everything is the record panel's Marks section. The same
 * argument `FindingLayer` makes for its margin tabs.
 */
export const MAX_GUTTER_DOTS = 12;

/**
 * The margin's entries for one page: marks first, then findings, then answers —
 * the reader's own ink, the assistant's conclusions, the conversation. Grouped
 * rather than interleaved so the three colours read as three kinds of thing.
 */
export function gutterEntries(
  path: string,
  page: number,
  citations?: Map<number, PageCitation[]> | null,
): GutterEntry[] {
  const out: GutterEntry[] = [];

  const marks: Mark[] = getMarks(path).filter((m) => m.page === page);
  for (const mark of marks.slice(0, MAX_GUTTER_DOTS)) {
    out.push({
      kind: "mark",
      id: mark.id,
      note: mark.note || mark.text,
      fromNote: !!mark.note,
      page,
    });
  }

  const all = getFindings(path);
  const findings: Finding[] = findingsOnPage(path, page).filter(
    // Struck by the reader, or replaced by a later claim: both stay in the
    // record, where the history is the point; neither is drawn as though it
    // still stood. The same rule the finding layer applies to the page.
    (f) => !f.struck && !isSuperseded(all, f.id),
  );
  for (const finding of findings.slice(0, MAX_GUTTER_DOTS)) {
    out.push({ kind: "finding", id: finding.id, note: finding.claim, page });
  }

  const cited = citations?.get(page) ?? [];
  for (const citation of cited.slice(0, MAX_GUTTER_DOTS)) {
    out.push({
      kind: "answer",
      id: citation.messageId,
      note: citation.quote ?? "",
      page,
    });
  }

  return out;
}
