/**
 * What local OCR read, on disk, per document (14.0).
 *
 * One file per content fingerprint, written by `ocr_cache_write` in Rust. The
 * format is compact because a scan is mostly words: every word's box costs
 * four numbers, rounded to a tenth of a point — far finer than any highlight
 * needs, and a third of the size of full precision.
 *
 * A file that does not parse, was written by another version, or was read
 * with other language models is ignored rather than trusted: the cost of
 * ignoring it is re-reading the pages, the cost of trusting it is highlights
 * in the wrong place.
 */
import { invokeCmd } from "../invoke-cmd";
import type { TextItemRect } from "../types";
import type { OcrLanguages } from "./ocr-engine";
import type { OcrPage } from "./ocr-result";

const VERSION = 1;

/** A recognised page as the service keeps it: the page, and what it cost. */
export interface StoredOcrPage extends OcrPage {
  page: number;
  /** Milliseconds the recognition took, render included. */
  ms: number;
}

interface EncodedPage {
  p: number;
  c: number;
  ms: number;
  t: string;
  /** Word texts. */
  w: string[];
  /** Four numbers per word: x, y, width, height, in PDF points. */
  b: number[];
}

interface EncodedDoc {
  v: number;
  langs: string;
  pages: EncodedPage[];
}

const tenth = (n: number) => Math.round(n * 10) / 10;

export function encodeOcrDoc(langs: OcrLanguages, pages: Iterable<StoredOcrPage>): string {
  const out: EncodedDoc = { v: VERSION, langs, pages: [] };
  for (const p of pages) {
    const b: number[] = [];
    for (const it of p.items) b.push(tenth(it.rect.x), tenth(it.rect.y), tenth(it.rect.width), tenth(it.rect.height));
    out.pages.push({ p: p.page, c: tenth(p.confidence), ms: Math.round(p.ms), t: p.text, w: p.items.map((i) => i.text), b });
  }
  out.pages.sort((a, b) => a.p - b.p);
  return JSON.stringify(out);
}

function decodePage(raw: unknown): StoredOcrPage | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Partial<EncodedPage>;
  if (
    typeof e.p !== "number" ||
    !Number.isInteger(e.p) ||
    e.p < 1 ||
    typeof e.c !== "number" ||
    typeof e.t !== "string" ||
    !Array.isArray(e.w) ||
    !Array.isArray(e.b) ||
    e.b.length !== e.w.length * 4
  ) {
    return null;
  }
  const items: TextItemRect[] = [];
  for (let i = 0; i < e.w.length; i++) {
    const text = e.w[i];
    const [x, y, width, height] = e.b.slice(i * 4, i * 4 + 4);
    if (typeof text !== "string" || ![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) {
      return null;
    }
    items.push({ text, rect: { x: x!, y: y!, width: width!, height: height! } });
  }
  return { page: e.p, confidence: e.c, text: e.t, items, ms: typeof e.ms === "number" ? e.ms : 0 };
}

/** The pages in a stored document, or [] when it is unusable for `langs`. */
export function decodeOcrDoc(json: string, langs: OcrLanguages): StoredOcrPage[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object") return [];
  const doc = raw as Partial<EncodedDoc>;
  if (doc.v !== VERSION || doc.langs !== langs || !Array.isArray(doc.pages)) return [];
  const pages: StoredOcrPage[] = [];
  for (const p of doc.pages) {
    const decoded = decodePage(p);
    if (decoded) pages.push(decoded);
  }
  return pages;
}

export async function readOcrDoc(identity: string, langs: OcrLanguages): Promise<StoredOcrPage[]> {
  try {
    const json = await invokeCmd<string | null>("ocr_cache_read", { identity });
    return json ? decodeOcrDoc(json, langs) : [];
  } catch {
    return [];
  }
}

export async function writeOcrDoc(
  identity: string,
  langs: OcrLanguages,
  pages: Iterable<StoredOcrPage>,
): Promise<void> {
  await invokeCmd<void>("ocr_cache_write", { identity, json: encodeOcrDoc(langs, pages) });
}

export async function getOcrCacheStats(): Promise<{ bytes: number; docs: number }> {
  try {
    const [bytes, docs] = await invokeCmd<[number, number]>("ocr_cache_stats");
    return { bytes, docs };
  } catch {
    return { bytes: 0, docs: 0 };
  }
}

export async function clearOcrCache(): Promise<void> {
  await invokeCmd<void>("ocr_cache_clear");
}
