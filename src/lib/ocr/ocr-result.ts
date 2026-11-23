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

interface OcrSubLine {
  items: TextItemRect[];
  text: string;
  minX: number;
  maxX: number;
  midY: number;
  height: number;
  paraId: number;
}

const GUTTER_NOISE_RE = /^[~_=|\\]{2,}$/;

function isNoiseSpeck(word: string, confidence: number, widthPt: number, heightPt: number): boolean {
  if (GUTTER_NOISE_RE.test(word) && confidence < 75) return true;
  // Microscopic 1–2px scan specks (`height < 2.2pt`) misread as `"i"` / `"Co"` at low confidence.
  if (heightPt < 2.2 && confidence < 65) return true;
  if (widthPt < 1.2 && heightPt < 2.5 && confidence < 65) return true;
  return false;
}

function buildSubLine(words: TextItemRect[], paraId: number): OcrSubLine {
  let text = "";
  let minX = Infinity;
  let maxX = -Infinity;
  let sumMidY = 0;
  let maxH = 0;
  for (const w of words) {
    text = joinWords(text, w.text);
    minX = Math.min(minX, w.rect.x);
    maxX = Math.max(maxX, w.rect.x + w.rect.width);
    sumMidY += w.rect.y + w.rect.height / 2;
    maxH = Math.max(maxH, w.rect.height);
  }
  return {
    items: words,
    text,
    minX,
    maxX,
    midY: sumMidY / Math.max(1, words.length),
    height: maxH,
    paraId,
  };
}

/**
 * Detect a clear two-column vertical gutter `gx` when >= 4 wide column sub-lines
 * sit strictly on each side of `gx` so interleaved left/right OCR lines are
 * reconstructed into true top-to-bottom column reading order (30.0).
 */
function detectTwoColumnGutter(subLines: readonly OcrSubLine[]): number | null {
  if (subLines.length < 8) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const l of subLines) {
    minX = Math.min(minX, l.minX);
    maxX = Math.max(maxX, l.maxX);
  }
  const span = maxX - minX;
  if (span < 260) return null;

  const zoneLo = minX + span * 0.36;
  const zoneHi = minX + span * 0.64;
  let bestGx: number | null = null;
  let bestScore = -Infinity;

  for (let gx = zoneLo; gx <= zoneHi; gx += 4) {
    let leftCols = 0;
    let rightCols = 0;
    let narrowCross = 0;
    for (const l of subLines) {
      const w = l.maxX - l.minX;
      if (l.maxX <= gx - 3) {
        if (w >= 55) leftCols += 1;
      } else if (l.minX >= gx + 3) {
        if (w >= 55) rightCols += 1;
      } else if (w < span * 0.55) {
        // A narrow sub-line straddling `gx` means `gx` cuts through a table column, not a gutter.
        narrowCross += 1;
      }
    }
    if (leftCols >= 4 && rightCols >= 4 && narrowCross <= 1) {
      const balance = Math.min(leftCols, rightCols) * 3 + (leftCols + rightCols) - narrowCross * 10;
      if (balance > bestScore) {
        bestScore = balance;
        bestGx = gx;
      }
    }
  }
  return bestGx;
}

function sortBandTopDown(lines: OcrSubLine[]): OcrSubLine[] {
  return [...lines].sort((a, b) => {
    const h = Math.max(a.height, b.height, 1);
    if (Math.abs(a.midY - b.midY) < h * 0.55) return a.minX - b.minX;
    return b.midY - a.midY;
  });
}

function orderSubLines(subLines: OcrSubLine[]): OcrSubLine[] {
  if (subLines.length <= 1) return subLines;
  const gx = detectTwoColumnGutter(subLines);
  if (gx === null) return subLines;

  let minX = Infinity;
  let maxX = -Infinity;
  for (const l of subLines) {
    minX = Math.min(minX, l.minX);
    maxX = Math.max(maxX, l.maxX);
  }
  const span = maxX - minX;
  const topSorted = sortBandTopDown(subLines);

  const ordered: OcrSubLine[] = [];
  let band: OcrSubLine[] = [];
  const flushBand = () => {
    if (band.length === 0) return;
    const left = band.filter((l) => l.maxX <= gx);
    const right = band.filter((l) => l.minX >= gx);
    const middle = band.filter((l) => l.maxX > gx && l.minX < gx);
    if (left.length >= 2 && right.length >= 2 && middle.length === 0) {
      ordered.push(...sortBandTopDown(left), ...sortBandTopDown(right));
    } else {
      ordered.push(...sortBandTopDown(band));
    }
    band = [];
  };

  for (const l of topSorted) {
    const isFullSpan = l.minX < gx - 12 && l.maxX > gx + 12 && l.maxX - l.minX >= span * 0.52;
    if (isFullSpan) {
      flushBand();
      ordered.push(l);
    } else {
      band.push(l);
    }
  }
  flushBand();
  return ordered;
}

export function ocrPageFrom(page: OcrPageIn, toPdf: PixelToPdf): OcrPage {
  const rawSubLines: OcrSubLine[] = [];
  let weighted = 0;
  let chars = 0;
  let paraSeq = 0;

  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      paraSeq += 1;
      for (const line of paragraph.lines) {
        const lineWords: TextItemRect[] = [];
        for (const word of line.words) {
          const w = word.text.trim();
          if (!w || (word.confidence < MIN_WORD_CONFIDENCE && !/[\p{L}\p{N}]/u.test(w))) continue;
          const rect = rectOf(word.bbox, toPdf);
          if (rect.width <= 0 || rect.height <= 0) continue;
          if (isNoiseSpeck(w, word.confidence, rect.width, rect.height)) continue;
          lineWords.push({ text: w, rect });
          weighted += word.confidence * w.length;
          chars += w.length;
        }
        if (lineWords.length === 0) continue;

        // Split horizontal lines merged across wide column gutters (`gap >= 15pt` and `>= 1.9 * height`).
        let current: TextItemRect[] = [lineWords[0]!];
        for (let i = 1; i < lineWords.length; i += 1) {
          const prev = current[current.length - 1]!;
          const next = lineWords[i]!;
          const gap = next.rect.x - (prev.rect.x + prev.rect.width);
          const refH = Math.max(prev.rect.height, next.rect.height, 1);
          if (gap >= Math.max(15, refH * 1.9)) {
            rawSubLines.push(buildSubLine(current, paraSeq));
            current = [next];
          } else {
            current.push(next);
          }
        }
        rawSubLines.push(buildSubLine(current, paraSeq));
      }
    }
  }

  const ordered = orderSubLines(rawSubLines);
  const items: TextItemRect[] = [];
  const paragraphs: string[] = [];
  let curLines: string[] = [];
  let prevLine: OcrSubLine | null = null;

  for (const sub of ordered) {
    for (const it of sub.items) items.push(it);
    if (prevLine) {
      const refH = Math.max(prevLine.height, sub.height, 1);
      const sameRow = Math.abs(prevLine.midY - sub.midY) < refH * 0.55 && sub.minX > prevLine.maxX;
      if (sameRow && curLines.length > 0) {
        curLines[curLines.length - 1] = `${curLines[curLines.length - 1]} | ${sub.text}`;
        prevLine = sub;
        continue;
      }
      const colJump = sub.midY > prevLine.midY + refH * 1.5;
      const paraGap = prevLine.midY - sub.midY > refH * 2.1;
      const diffPara = sub.paraId !== prevLine.paraId && Math.abs(sub.minX - prevLine.minX) > refH * 2;
      if (colJump || paraGap || diffPara) {
        if (curLines.length > 0) {
          paragraphs.push(joinLines(curLines));
          curLines = [];
        }
      }
    }
    curLines.push(sub.text);
    prevLine = sub;
  }
  if (curLines.length > 0) paragraphs.push(joinLines(curLines));

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
