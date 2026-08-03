import type { PageText } from "./types";

export const MIN_INDEX_CHARS = 20;

type TextSource = "native" | "vision";

/**
 * Decide which of two versions of a page's text to keep.
 *
 * Provenance outranks length. Native extraction produces Markdown, which is
 * routinely longer than a vision transcription of the same page — so a
 * length-only rule lets free text displace text the user was billed for, both
 * when a vision result lands and again on every reopen. Length only decides
 * between two texts of the same origin.
 */
export function pickBetterPageText(
  existing: string,
  incoming: string,
  existingSource?: TextSource,
  incomingSource?: TextSource,
): string {
  const a = existing.trim();
  const b = incoming.trim();

  const aPaid = existingSource === "vision" && a.length >= MIN_INDEX_CHARS;
  const bPaid = incomingSource === "vision" && b.length >= MIN_INDEX_CHARS;
  if (aPaid !== bPaid) return aPaid ? existing : incoming;

  if (a.length >= MIN_INDEX_CHARS && b.length < MIN_INDEX_CHARS) return existing;
  if (b.length >= MIN_INDEX_CHARS && a.length < MIN_INDEX_CHARS) return incoming;
  // Same origin and both usable: the longer one saw more of the page.
  if (a.length >= MIN_INDEX_CHARS && b.length >= MIN_INDEX_CHARS) {
    return b.length > a.length * 1.25 ? incoming : existing;
  }
  return b.length >= a.length ? incoming : existing;
}

/** Merge freshly extracted pages with any cached vision text for the same path. */
export function mergePageTextsOnReload(existing: PageText[], incoming: PageText[]): PageText[] {
  const byPage = new Map(existing.map((p) => [p.page, p]));
  const incomingPages = new Set(incoming.map((p) => p.page));
  const merged: PageText[] = incoming.map((p) => {
    const prev = byPage.get(p.page);
    const text = pickBetterPageText(prev?.text ?? "", p.text, prev?.source, p.source);
    // The winning text keeps its own provenance, or the next merge would treat
    // paid-for text as free and drop it.
    const source = prev && text === prev.text ? prev.source : p.source;
    return { page: p.page, text, source };
  });
  for (const p of existing) {
    if (!incomingPages.has(p.page) && p.text.trim().length >= MIN_INDEX_CHARS) {
      merged.push(p);
    }
  }
  return merged.sort((a, b) => a.page - b.page);
}

export function pagesTextChanged(before: PageText[], after: PageText[]): boolean {
  if (before.length !== after.length) return true;
  const beforeMap = new Map(before.map((p) => [p.page, p.text]));
  for (const p of after) {
    if (beforeMap.get(p.page) !== p.text) return true;
  }
  for (const p of before) {
    if (!after.some((a) => a.page === p.page)) return true;
  }
  return false;
}
