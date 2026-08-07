import { linksOnPages, type PageLink } from "../page-links";
import { marksOnPage } from "../mark-store";
import type { LoadedDocument } from "../types";
import type { ReadAttachments } from "./result";

/**
 * What travels beside the page text, for the pages that were actually sent.
 *
 * Both readers used to assemble this themselves, and they disagreed. The range
 * reader computed marks and links across its whole range without asking which
 * pages had returned text, so a page deduplicated down to a one-line marker
 * still shipped every mark on it — the dedup saved the page and the attachments
 * resent a piece of it. The page reader's early return carried nothing at all.
 * One guarantee, two readers, two answers, two hundred lines apart in the same
 * file; that is the same shape as the bug 7.3 fixed, so this time the assembly
 * lives in one place that both call.
 *
 * The rule: **an attachment belongs to a page whose text this result carried.**
 * A page the reader is being pointed at rather than shown has its links and
 * marks in the earlier result already.
 */

/**
 * How much of a marked passage travels with a read.
 *
 * A mark's text is, by definition, words from the page being read — so sending
 * it whole means the same passage twice in one result, up to 500 characters of
 * it. The outline path worked this out long ago and caps at the same number:
 * the snippet is there to identify which mark this is, and the page text beside
 * it is where the passage actually lives.
 */
export const MARK_SNIPPET_CHARS = 120;

export interface MarkAttachmentOut {
  page: number;
  text: string;
  note?: string;
}

/**
 * Assemble the attachments for a read.
 *
 * `deliveredPages` is the pages whose text is in this result — not the pages
 * that were asked for.
 */
export function attachmentsFor(
  doc: LoadedDocument,
  path: string,
  deliveredPages: readonly number[],
): ReadAttachments {
  if (deliveredPages.length === 0) return {};

  const out: ReadAttachments = {};

  const links: PageLink[] = linksOnPages(doc.links, deliveredPages);
  if (links.length > 0) out.links = links;

  const marks: MarkAttachmentOut[] = deliveredPages
    .flatMap((page) => marksOnPage(path, page))
    .map((m) => ({
      page: m.page,
      text:
        m.text.length > MARK_SNIPPET_CHARS
          ? `${m.text.slice(0, MARK_SNIPPET_CHARS)}…`
          : m.text,
      // The note is the reader's own words and exists nowhere else in the
      // document, so unlike the passage it is never truncated here.
      ...(m.note ? { note: m.note } : {}),
    }));
  if (marks.length > 0) out.marks = marks;

  return out;
}

/** Characters an assembled attachment set costs, for the run's read budget. */
export function attachmentCost(attachments: ReadAttachments): number {
  if (!attachments.links && !attachments.marks) return 0;
  try {
    return JSON.stringify(attachments).length;
  } catch {
    return 0;
  }
}
