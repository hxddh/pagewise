import type { DocHeading, PageText } from "./types";
import { unreadRelevantPages } from "./coverage";

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

export type FollowUpKind = "unreadRelevant" | "nextSection" | "compareMarks" | "wholeDocument";

export interface FollowUp {
  kind: FollowUpKind;
  /** Filled into the composer verbatim. */
  text: string;
  /** For "nextSection": the section it points at. */
  section?: string;
  /** For "unreadRelevant": the pages not read that match the question. */
  pages?: number[];
}

export interface FollowUpInput {
  /** Pages this reply actually read, in the order it read them. */
  readPages: number[];
  /** The document's section list, if one was recovered. */
  outline: DocHeading[];
  totalPages: number;
  /** Passages the reader has marked in this document. */
  markCount: number;
  /** The question this reply answered, and the reply itself (15.0). */
  question?: string;
  answerText?: string;
  /** The document's page texts, to find pages the question matches. */
  pages?: readonly PageText[];
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const MAX_FOLLOW_UPS = 3;
/** Below this share of the document, "read the whole thing" is still on offer. */
const WHOLE_DOC_SHARE = 0.25;

export function followUpSuggestions({
  readPages,
  outline,
  totalPages,
  markCount,
  question,
  answerText,
  pages,
  t,
}: FollowUpInput): FollowUp[] {
  const out: FollowUp[] = [];

  // First, because it is the one that says the answer may be incomplete: the
  // question asked for all of something, and pages matching it were not read.
  if (question && pages) {
    const unread = unreadRelevantPages(pages, question, readPages, answerText);
    if (unread.length > 0) {
      out.push({
        kind: "unreadRelevant",
        pages: unread,
        text: t("agent.followUpUnread", { pages: unread.join(", "), count: unread.length }),
      });
    }
  }

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

  // Pages no search can reach are not suggested here since 16.0: the banner
  // above the composer offers to read them — one action, one place. As a
  // suggestion it only put "Scan the 12 unreadable pages" in the composer, as
  // a question for the model, which is not what reading them is.

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
