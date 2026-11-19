import { markdownToPlainText } from "./markdown-text";
import type { PageText } from "./types";

export const MAX_SEARCH_HITS = 200;

export interface SearchHit {
  page: number;
  index: number;
  snippet: string;
  match: string;
}

function snippetAround(text: string, index: number, matchLen: number, radius = 80): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + matchLen + radius);
  const chunk = text.slice(start, end).replace(/\s+/g, " ").trim();
  return start > 0 ? `…${chunk}` : chunk;
}

const LINE_WRAP_HYPHEN = /^[-‐‑]\r?\n\s*/;

/**
 * NFKC + lowercase fold with exact source UTF-16 index mapping:
 * - expands ligatures (`ﬁ` -> `fi`, `ﬂ` -> `fl`, `ﬀ` -> `ff`) and fullwidth ASCII,
 * - drops soft hyphens (`\u00AD`) and joins hyphenated line wraps (`im-\nprove`),
 * - collapses runs of whitespace (including line breaks) into a single `" "`.
 */
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let i = 0;
  let prevWasSpace = false;

  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const width = ch.length;

    if (cp === 0x00ad) {
      i += width;
      continue;
    }

    if (
      (ch === "-" || ch === "\u2010" || ch === "\u2011") &&
      i > 0 &&
      /\p{L}/u.test(text[i - 1]!)
    ) {
      const m = LINE_WRAP_HYPHEN.exec(text.slice(i));
      if (m && i + m[0].length < text.length && /\p{L}/u.test(text[i + m[0].length]!)) {
        i += m[0].length;
        continue;
      }
    }

    const norm = ch.normalize("NFKC").toLowerCase();
    for (const unit of norm) {
      if (/\s/.test(unit)) {
        if (!prevWasSpace) {
          folded += " ";
          map.push(i);
          prevWasSpace = true;
        }
      } else {
        folded += unit;
        map.push(i);
        prevWasSpace = false;
      }
    }
    i += width;
  }
  return { folded, map };
}

export function searchDocumentPages(
  pages: PageText[],
  query: string,
  limit = 80,
): SearchHit[] {
  pages = pages.map((p) => ({ ...p, text: markdownToPlainText(p.text) }));
  const rawQuery = query.trim();
  if (!rawQuery) return [];

  const foldedQuery = foldWithMap(rawQuery.normalize("NFC")).folded.trim();
  if (!foldedQuery) return [];

  const perPage: SearchHit[][] = [];
  let totalHits = 0;

  for (const { page, text } of pages) {
    const normText = text.normalize("NFC");
    const { folded, map } = foldWithMap(normText);

    const pageHits: SearchHit[] = [];
    let from = 0;
    const pageCap = Math.min(limit, 500);
    while (pageHits.length < pageCap) {
      const idx = folded.indexOf(foldedQuery, from);
      if (idx === -1) break;

      const startOrig = map[idx] ?? 0;
      const lastFoldIdx = idx + foldedQuery.length - 1;
      const lastOrig = map[lastFoldIdx] ?? startOrig;
      const lastCp = normText.codePointAt(lastOrig);
      const lastWidth = lastCp !== undefined ? String.fromCodePoint(lastCp).length : 1;
      const endOrig = Math.min(normText.length, lastOrig + lastWidth);

      pageHits.push({
        page,
        index: startOrig,
        match: normText.slice(startOrig, endOrig),
        snippet: snippetAround(normText, startOrig, endOrig - startOrig),
      });
      from = idx + Math.max(1, foldedQuery.length);
    }

    if (pageHits.length > 0) {
      perPage.push(pageHits);
      totalHits += pageHits.length;
    }
  }

  if (totalHits <= limit) return perPage.flat();

  // Fair multi-page allocation: never let a single dense page monopolize `limit`
  // and starve later matching pages.
  const selected: SearchHit[] = [];
  const cursors = new Array<number>(perPage.length).fill(0);
  while (selected.length < limit) {
    let progressed = false;
    for (let p = 0; p < perPage.length && selected.length < limit; p += 1) {
      const idx = cursors[p]!;
      const list = perPage[p]!;
      if (idx < list.length) {
        selected.push(list[idx]!);
        cursors[p] = idx + 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return selected.sort((a, b) => a.page - b.page || a.index - b.index);
}

export function countSearchHits(pages: PageText[], query: string): number {
  const plain = pages.map((p) => markdownToPlainText(p.text));
  const foldedQuery = foldWithMap(query.trim().normalize("NFC")).folded.trim();
  if (!foldedQuery) return 0;
  let count = 0;
  for (const text of plain) {
    const { folded } = foldWithMap(text.normalize("NFC"));
    let from = 0;
    for (;;) {
      const idx = folded.indexOf(foldedQuery, from);
      if (idx === -1) break;
      count += 1;
      from = idx + Math.max(1, foldedQuery.length);
    }
  }
  return count;
}
