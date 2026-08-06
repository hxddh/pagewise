import type { DocHeading } from "./types";

/**
 * What is worth asking next, derived from what the run actually did.
 *
 * Every other agent that offers follow-ups asks a model to invent them, which
 * is a second billed generation for three lines of text — and this app spent
 * two versions removing exactly that kind of cost. The document already knows
 * what comes next: the section after the pages that were read, the pages a
 * search could not match, the passages the reader marked. Those make better
 * suggestions than a model guessing, and they cost nothing.
 *
 * The rules are deliberately few. A suggestion that is merely plausible is
 * worse than none: it invites a question the document cannot answer.
 */

export type FollowUpKind = "nextSection" | "scanUnindexed" | "compareMarks" | "wholeDocument";

export interface FollowUp {
  kind: FollowUpKind;
  /** Filled into the composer verbatim. */
  text: string;
  /** For "nextSection": the section it points at. */
  section?: string;
  /** For "scanUnindexed": how many pages are unreadable. */
  count?: number;
}

export interface FollowUpInput {
  /** Pages this reply actually read, in the order it read them. */
  readPages: number[];
  /** The document's section list, if one was recovered. */
  outline: DocHeading[];
  totalPages: number;
  /** Pages with too little text to search — a scan would be needed. */
  unindexedCount: number;
  /** Passages the reader has marked in this document. */
  markCount: number;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const MAX_FOLLOW_UPS = 3;
/** Below this share of the document, "read the whole thing" is still on offer. */
const WHOLE_DOC_SHARE = 0.25;

export function followUpSuggestions({
  readPages,
  outline,
  totalPages,
  unindexedCount,
  markCount,
  t,
}: FollowUpInput): FollowUp[] {
  const out: FollowUp[] = [];

  // The section after the last page this reply read. Not the section it read —
  // the reader has just been told about that one.
  const lastPage = readPages.length > 0 ? Math.max(...readPages) : 0;
  if (lastPage > 0 && outline.length > 0) {
    const next = outline.find((heading) => heading.page > lastPage);
    if (next?.title) {
      const title = next.title.trim().slice(0, 60);
      out.push({
        kind: "nextSection",
        section: title,
        text: t("agent.followUpNextSection", { section: title }),
      });
    }
  }

  // Pages no search can reach. This is the one suggestion that costs money to
  // act on, so it says how many pages before it is taken.
  if (unindexedCount > 0) {
    out.push({
      kind: "scanUnindexed",
      count: unindexedCount,
      text: t("agent.followUpScan", { count: unindexedCount }),
    });
  }

  // What the reader singled out is what they care about; an answer that did not
  // touch it is worth pointing at it.
  if (markCount > 0 && out.length < MAX_FOLLOW_UPS) {
    out.push({ kind: "compareMarks", text: t("agent.followUpMarks") });
  }

  // Only when this reply saw a small corner of the document.
  const share = totalPages > 0 ? readPages.length / totalPages : 1;
  if (out.length < MAX_FOLLOW_UPS && totalPages > 1 && share < WHOLE_DOC_SHARE) {
    out.push({ kind: "wholeDocument", text: t("agent.followUpWholeDoc") });
  }

  return out.slice(0, MAX_FOLLOW_UPS);
}
