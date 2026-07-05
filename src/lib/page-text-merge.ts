import type { PageText } from "./types";

export const MIN_INDEX_CHARS = 20;

/** Prefer indexed/OCR text over a sparse re-extract when reopening the same file. */
export function pickBetterPageText(existing: string, incoming: string): string {
  const a = existing.trim();
  const b = incoming.trim();
  if (a.length >= MIN_INDEX_CHARS && b.length < MIN_INDEX_CHARS) return existing;
  if (b.length >= MIN_INDEX_CHARS && a.length < MIN_INDEX_CHARS) return incoming;
  return b.length >= a.length ? incoming : existing;
}

/** Merge freshly extracted pages with any cached vision/OCR text for the same path. */
export function mergePageTextsOnReload(existing: PageText[], incoming: PageText[]): PageText[] {
  const byPage = new Map(existing.map((p) => [p.page, p.text]));
  return incoming.map((p) => ({
    page: p.page,
    text: pickBetterPageText(byPage.get(p.page) ?? "", p.text),
  }));
}

export function pagesTextChanged(before: PageText[], after: PageText[]): boolean {
  const beforeMap = new Map(before.map((p) => [p.page, p.text]));
  for (const p of after) {
    if (beforeMap.get(p.page) !== p.text) return true;
  }
  return before.length !== after.length;
}
