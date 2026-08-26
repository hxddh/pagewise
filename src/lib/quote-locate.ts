/**
 * Where on the page a quoted passage actually is.
 *
 * The assistant never sees a coordinate. Every one of the eight document tools
 * is text in, text out, and `finding-store.ts` wrote that down as a limit —
 * "the agent has no coordinates: it never sees the page as a picture. Pinning a
 * claim to a rectangle it did not choose would be an invented anchor" — while
 * `RecordPanel.tsx` concluded from the same premise that findings could never
 * be drawn beside the text they came from.
 *
 * The premise is right and the conclusion does not follow. The agent does not
 * have to supply a rectangle: it supplies the words, and we find them. The
 * anchor is derived here, locally, from `page_text_items` — the same command
 * the reader's own marks already round-trip through. Nothing is trusted that
 * the page itself does not confirm.
 *
 * WHICH MAKES THE FAILURE THE VALUABLE HALF. A quote that cannot be found on
 * the page it was attributed to is a quote that is not there. That check is
 * deterministic, local, and costs no model call — and for a reader whose whole
 * reason to use this is that the assistant's citation is really on the page,
 * catching a fabricated one is worth more than drawing a true one prettily.
 *
 * WHITESPACE IS DISCARDED ENTIRELY, on both sides. Runs reported by the
 * extractor are lines, so any quote longer than a line arrives split across
 * several of them — `matchingItems` in search-highlight.ts matches within a
 * single run and says so ("a phrase broken across two lines matches neither").
 * Joining runs with a space instead would break CJK, where a line break is not
 * a word boundary and inserting one puts a space in the middle of a sentence
 * the quote does not have. Dropping whitespace from both haystack and needle
 * handles wrapped English and wrapped Chinese with the same rule.
 *
 * What it does not handle: a word hyphenated across a line break. "reve-\nnue"
 * keeps its hyphen and will not match "revenue". That degrades to "not found",
 * which is the safe direction — an unlocated quote is reported as unlocated,
 * never as a fabrication of the reader's own making.
 */
import type { PdfRect, TextItemRect } from "./types";

/**
 * Shortest quote that may be located.
 *
 * Below this a match means nothing: four characters occur on almost every page,
 * so both "found" and "not found" would be noise, and the second is the one
 * that gets shown to a reader as doubt about a citation. Short quotes are
 * reported as uncheckable instead — see `LocateOutcome`.
 */
export const MIN_QUOTE_CHARS = 6;

/** Most runs one quote may span. A quote covering more is not one passage. */
export const MAX_QUOTE_ITEMS = 40;

export type LocateOutcome =
  /** Found: these runs carry it, in document order. */
  | { status: "located"; items: TextItemRect[]; rects: PdfRect[] }
  /** Looked for it on the page it was attributed to; it is not there. */
  | { status: "absent" }
  /** Too short, or nothing to look for. Neither confirmed nor doubted. */
  | { status: "uncheckable" };

/**
 * Case-fold and drop whitespace, recording where each surviving character came
 * from.
 *
 * Folded per code point rather than with one `toLowerCase` over the whole
 * string: that call can change length — U+0130 "İ" folds to "i" plus a
 * combining dot — which desyncs every offset after it from its source. The same
 * trap `document-search.ts` documents, and the same fix.
 */
function fold(text: string): { folded: string; source: number[] } {
  let folded = "";
  const source: number[] = [];
  let offset = 0;
  for (const ch of text) {
    const width = ch.length;
    if (!/\s/.test(ch)) {
      for (const unit of ch.toLowerCase()) {
        folded += unit;
        source.push(offset);
      }
    }
    offset += width;
  }
  return { folded, source };
}

/** The whole page as one folded string, plus which run each character is in. */
function foldItems(items: readonly TextItemRect[]): { folded: string; itemAt: number[] } {
  let folded = "";
  const itemAt: number[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const { folded: part } = fold(items[i]!.text.normalize("NFC"));
    folded += part;
    for (let k = 0; k < part.length; k += 1) itemAt.push(i);
  }
  return { folded, itemAt };
}

/**
 * Find a quote among a page's text runs.
 *
 * `items` must be the runs of the page the quote was attributed to. Searching
 * the whole document instead would turn "this claim cites the wrong page" into
 * a highlight somewhere else, which is precisely the error worth catching.
 */
export function locateQuote(items: readonly TextItemRect[], quote: string): LocateOutcome {
  const { folded: needle } = fold((quote ?? "").normalize("NFC"));
  if (needle.length < MIN_QUOTE_CHARS) return { status: "uncheckable" };
  if (items.length === 0) return { status: "absent" };

  const { folded, itemAt } = foldItems(items);
  const at = folded.indexOf(needle);
  if (at < 0) return { status: "absent" };

  const first = itemAt[at]!;
  const last = itemAt[at + needle.length - 1]!;
  const span = items.slice(first, Math.min(last + 1, first + MAX_QUOTE_ITEMS));
  return { status: "located", items: span, rects: span.map((item) => item.rect) };
}

/**
 * The union of a located quote's runs, as one rectangle in PDF points.
 *
 * Used to place a margin note beside the passage rather than to draw over it:
 * the individual runs are what gets underlined, and the union is where the note
 * points. Bottom-left origin throughout, because that is what `page_text_items`
 * reports — see `pdfRectToBox` versus `topLeftRectToBox`, and 9.2.3 for what
 * confusing the two costs.
 */
export function unionRect(rects: readonly PdfRect[]): PdfRect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
