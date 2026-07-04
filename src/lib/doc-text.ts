import { docCache } from "./doc-cache";
import { MIN_INDEX_CHARS } from "./vision-index";

/** Read page text length from docCache (authoritative) with optional React doc fallback. */
export function getPageTextLen(
  path: string,
  page: number,
  fallbackPages?: { page: number; text: string }[],
): number {
  const cached = docCache.getPages(path).find((p) => p.page === page);
  if (cached) return cached.text.trim().length;
  return fallbackPages?.find((p) => p.page === page)?.text.trim().length ?? 0;
}

export function pageHasIndexableText(
  path: string,
  page: number,
  fallbackPages?: { page: number; text: string }[],
): boolean {
  return getPageTextLen(path, page, fallbackPages) >= MIN_INDEX_CHARS;
}
