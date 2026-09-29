/**
 * A page recognised by local OCR, in the shapes the rest of PageWise already
 * speaks (14.0).
 *
 * The point of OCR here is not the text — a vision model reads a scan more
 * fluently — but the boxes. `page_text_items` runs are what a citation is
 * located among, what a finding is drawn from, what a search hit lights up and
 * what a selection reads. A scanned page had none of them, so every one of
 * those features stopped at the edge of a scan. OCR words are emitted as the
 * same `TextItemRect`s, in the same frame — PDF points, bottom-left origin,
 * absolute user space, as `inspect.rs` hands them out since 13.1 — so every
 * consumer above works on a scan without knowing it is one.
 *
 * One run per word, not per line: on a two-column page a recognised line can
 * run straight across the gutter, and the reading-order matcher in
 * `quote-locate.ts` can only follow the columns if it is given the words.
 * Measured in the 14.0 spike: 57.9% of quotes located with line runs, 77.5%
 * with word runs.
 */
import type { TextItemRect } from "../types";

/** Tesseract's box, in image pixels, top-left origin. */
export interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWordIn {
  text: string;
  confidence: number;
  bbox: PixelBox;
}

/** The subset of tesseract.js's `Page` this reads. */
export interface OcrPageIn {
  blocks: Array<{
    paragraphs: Array<{
      lines: Array<{ words: OcrWordIn[] }>;
    }>;
  }> | null;
}

export interface OcrPage {
  /** One run per recognised word, PDF points, bottom-left origin, absolute user space. */
  items: TextItemRect[];
  /** The page's words in reading order, lines joined into paragraphs. */
  text: string;
  /** Mean word confidence 0–100, weighted by characters. 0 when nothing was read. */
  confidence: number;
}

/** Maps an image pixel to PDF user space — pdf.js's `viewport.convertToPdfPoint`. */
export type PixelToPdf = (x: number, y: number) => [number, number];

const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;

/**
 * Below this a word with no letter or digit in it is noise: a speck, a rule,
 * a smudge read as punctuation. Only such words are dropped. tesseract's
 * confidence is badly calibrated on real words — `developers’` and `存储、`
 * both came back at 0, correctly read — and dropping them cost 9 points of
 * Chinese and 2 of English in the 14.0 evaluation, at no gain in false
 * positives.
 */
export const MIN_WORD_CONFIDENCE = 30;

/**
 * The resolution a page is rendered at for these models. Chinese glyphs are
 * dense: at 200 dpi a 10.5 pt character is under 30 px and strokes merge, and
 * 300 dpi read 9 points more Chinese quotes correctly in the evaluation. It
 * read English no better and two-column pages slightly worse, and costs half
 * again the pixels, so English stays at 200.
 */
export function ocrDpiFor(langs: string): number {
  return langs.includes("chi_sim") ? 300 : 200;
}

function rectOf(box: PixelBox, toPdf: PixelToPdf) {
  const [ax, ay] = toPdf(box.x0, box.y0);
  const [bx, by] = toPdf(box.x1, box.y1);
  const x = Math.min(ax, bx);
  const y = Math.min(ay, by);
  return { x, y, width: Math.abs(bx - ax), height: Math.abs(by - ay) };
}

/** Join two pieces of a line: no space between CJK characters, as they were set. */
export function joinWords(a: string, b: string): string {
  if (!a) return b;
  const last = a[a.length - 1]!;
  const first = b[0] ?? "";
  return CJK.test(last) && CJK.test(first) ? a + b : `${a} ${b}`;
}

/** Join a paragraph's lines, rejoining a word hyphenated at a line end. */
function joinLines(lines: string[]): string {
  let out = "";
  for (const line of lines) {
    if (!out) {
      out = line;
      continue;
    }
    if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(line)) out = out.slice(0, -1) + line;
    else out = joinWords(out, line);
  }
  return out;
}

export function ocrPageFrom(page: OcrPageIn, toPdf: PixelToPdf): OcrPage {
  const items: TextItemRect[] = [];
  const paragraphs: string[] = [];
  let weighted = 0;
  let chars = 0;
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      const lines: string[] = [];
      for (const line of paragraph.lines) {
        let text = "";
        for (const word of line.words) {
          const w = word.text.trim();
          if (!w || (word.confidence < MIN_WORD_CONFIDENCE && !/[\p{L}\p{N}]/u.test(w))) continue;
          const rect = rectOf(word.bbox, toPdf);
          if (rect.width <= 0 || rect.height <= 0) continue;
          items.push({ text: w, rect });
          text = joinWords(text, w);
          weighted += word.confidence * w.length;
          chars += w.length;
        }
        if (text) lines.push(text);
      }
      if (lines.length) paragraphs.push(joinLines(lines));
    }
  }
  return { items, text: paragraphs.join("\n\n"), confidence: chars ? weighted / chars : 0 };
}

/**
 * The pixel→PDF mapping for a page image rendered at `scale` with no rotation
 * or crop offset — what the evaluation uses, where there is no pdf.js
 * viewport. The app uses the viewport's own inverse, which handles both.
 */
export function flatPixelToPdf(scale: number, pageHeightPt: number, originX = 0, originY = 0): PixelToPdf {
  return (x, y) => [originX + x / scale, originY + pageHeightPt - y / scale];
}
