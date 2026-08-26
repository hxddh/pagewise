import type { DocHeading } from "./types";

/**
 * Which outline entry is the reader currently inside?
 *
 * A heading owns every page from its own up to the next heading's, so the
 * answer is the last entry at or before the current page. Before the first
 * heading — a cover or a title page — nothing is active, which is honest: the
 * reader is not in a section yet.
 *
 * Returns an index into `outline`, or -1.
 */
export function activeHeadingIndex(outline: DocHeading[], page: number): number {
  let active = -1;
  for (let i = 0; i < outline.length; i++) {
    const heading = outline[i]!;
    if (heading.page > page) break;
    active = i;
  }
  return active;
}

/**
 * Drop entries that would render as an empty or unusable row.
 *
 * The outline is synthesized from the page text, so a document can contribute a
 * heading whose title is whitespace or whose page fell outside the document.
 */
export function usableOutline(
  outline: DocHeading[] | undefined,
  totalPages: number,
): DocHeading[] {
  if (!outline) return [];
  return outline.filter(
    (h) =>
      h.title.trim().length > 0 &&
      Number.isInteger(h.page) &&
      h.page >= 1 &&
      (totalPages <= 0 || h.page <= totalPages),
  );
}

/**
 * Which section list wins, of the three a PDF can offer.
 *
 * BOOKMARKS the author wrote are the document's own navigation, curated at the
 * level someone thought you would want to move through it. They win when there
 * are any.
 *
 * TAGGED HEADINGS come next. A tagged PDF marks its own runs of text `H1`..`H6`
 * — also the document's answer, and exhaustive where bookmarks are curated, but
 * it lists every heading rather than the ones worth navigating by.
 *
 * SYNTHESIZED headings are last, because they are a guess: markdown recovered
 * from font sizes, which is what you fall back to when the document says
 * nothing about its own structure. Most documents say nothing.
 *
 * ARBITRATED ONCE, AT LOAD, AND STORED. This used to be a rule every consumer
 * had to remember, and the comment here said so — and they did not: the agent
 * called this function while the outline sidebar and the chat panel read the
 * synthesized list directly. On any PDF with bookmarks the reader and the model
 * were looking at different section names, which is the exact failure this
 * comment warned about. A rule that has to be remembered in four places is not
 * a rule; `load-document.ts` resolves it once and everything downstream reads
 * the winner.
 */
export function preferAuthoredOutline(
  authored: DocHeading[],
  structure: DocHeading[],
  synthesized: DocHeading[],
): DocHeading[] {
  if (authored.length > 0) return authored;
  if (structure.length > 0) return structure;
  return synthesized;
}
