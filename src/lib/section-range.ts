import type { DocHeading } from "./types";

export interface SectionRange {
  title: string;
  startPage: number;
  /** Inclusive. The page before the next heading, or the last page. */
  endPage: number;
}

/**
 * Where a section starts and ends.
 *
 * A heading owns everything until the next heading at the same level or
 * shallower — a subsection does not end its parent. The last section runs to
 * the end of the document.
 */
export function sectionRange(
  outline: DocHeading[],
  index: number,
  totalPages: number,
): SectionRange | null {
  const heading = outline[index];
  if (!heading) return null;
  // A heading pointing past the end of the document cannot define a section.
  // Clamping it would invent a range over pages it never covered.
  if (totalPages > 0 && heading.page > totalPages) return null;

  let endPage = totalPages;
  for (let i = index + 1; i < outline.length; i++) {
    const next = outline[i]!;
    if (next.level > heading.level) continue;
    // A section can end on the page its successor starts: both may share it.
    endPage = Math.max(heading.page, next.page - 1);
    break;
  }

  return {
    title: heading.title,
    startPage: heading.page,
    endPage: Math.max(heading.page, Math.min(endPage, totalPages)),
  };
}

/**
 * Find the section a request names.
 *
 * The model quotes a heading as it appeared in the outline, but rarely
 * character-for-character — it drops a numeric prefix, or keeps only the words.
 * Exact match wins; otherwise the shortest heading containing the request, so
 * "Kompaktheit" prefers the section over a longer heading mentioning it.
 * Returns an index into `outline`, or -1.
 */
export function findSectionIndex(outline: DocHeading[], query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return -1;

  let exact = -1;
  let best = -1;
  for (let i = 0; i < outline.length; i++) {
    const title = outline[i]!.title.trim().toLowerCase();
    if (title === needle) {
      exact = i;
      break;
    }
    if (title.includes(needle) || needle.includes(title)) {
      if (best === -1 || outline[i]!.title.length < outline[best]!.title.length) {
        best = i;
      }
    }
  }
  return exact !== -1 ? exact : best;
}
