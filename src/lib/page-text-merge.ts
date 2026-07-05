import type { PageText } from "./types";

export const MIN_INDEX_CHARS = 20;

/** Prefer indexed/OCR text over a sparse re-extract when reopening the same file. */
export function pickBetterPageText(existing: string, incoming: string): string {
  const a = existing.trim();
  const b = incoming.trim();
  if (a.length >= MIN_INDEX_CHARS && b.length < MIN_INDEX_CHARS) return existing;
  if (b.length >= MIN_INDEX_CHARS && a.length < MIN_INDEX_CHARS) return incoming;
  // Both sufficient: prefer longer text (native extract may beat stale OCR).
  if (a.length >= MIN_INDEX_CHARS && b.length >= MIN_INDEX_CHARS) {
    return b.length > a.length * 1.25 ? incoming : existing;
  }
  return b.length >= a.length ? incoming : existing;
}

/** Merge freshly extracted pages with any cached vision/OCR text for the same path. */
export function mergePageTextsOnReload(existing: PageText[], incoming: PageText[]): PageText[] {
  const byPage = new Map(existing.map((p) => [p.page, p.text]));
  const incomingPages = new Set(incoming.map((p) => p.page));
  const merged = incoming.map((p) => ({
    page: p.page,
    text: pickBetterPageText(byPage.get(p.page) ?? "", p.text),
  }));
  for (const p of existing) {
    if (!incomingPages.has(p.page) && p.text.trim().length >= MIN_INDEX_CHARS) {
      merged.push({ page: p.page, text: p.text });
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
