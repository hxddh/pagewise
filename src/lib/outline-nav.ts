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
