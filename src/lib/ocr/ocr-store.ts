/**
 * What local OCR read, on disk, per document (14.0).
 *
 * One file per content fingerprint, written by `ocr_cache_write` in Rust. The
 * format is compact because a scan is mostly words: every word's box costs
 * four numbers, rounded to a tenth of a point — far finer than any highlight
 * needs, and a third of the size of full precision.
 *
 * A file that does not parse, or was written by another version, is ignored
 * rather than trusted: the cost of ignoring it is re-reading the pages, the
 * cost of trusting it is highlights in the wrong place.
 *
 * Since 16.0 a file keeps one section per set of language models. Before, it
 * held only the last set used, so switching the recognition language and back
 * overwrote everything read in the first (B7).
 */
import { invokeCmd } from "../invoke-cmd";
import type { TextItemRect } from "../types";
import type { OcrLanguages } from "./ocr-engine";
import type { OcrPage } from "./ocr-result";

const VERSION = 2;

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

/** 14.0's format: one set of models per file. Still read. */
interface EncodedDocV1 {
  v: 1;
  langs: string;
  pages: EncodedPage[];
}

interface EncodedDoc {
  v: typeof VERSION;
  /** Pages read with each set of language models. */
  sections: Record<string, EncodedPage[]>;
}

const tenth = (n: number) => Math.round(n * 10) / 10;

function encodePages(pages: Iterable<StoredOcrPage>): EncodedPage[] {
  const out: EncodedPage[] = [];
  for (const p of pages) {
    const b: number[] = [];
    for (const it of p.items) b.push(tenth(it.rect.x), tenth(it.rect.y), tenth(it.rect.width), tenth(it.rect.height));
    out.push({ p: p.page, c: tenth(p.confidence), ms: Math.round(p.ms), t: p.text, w: p.items.map((i) => i.text), b });
  }
  return out.sort((a, b) => a.p - b.p);
}

/** Every section a stored file holds, whichever version wrote it; {} when unusable. */
function sectionsOf(json: string | null): Record<string, EncodedPage[]> {
  if (!json) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object") return {};
  const v1 = raw as Partial<EncodedDocV1>;
  if (v1.v === 1 && typeof v1.langs === "string" && Array.isArray(v1.pages)) return { [v1.langs]: v1.pages };
  const doc = raw as Partial<EncodedDoc>;
  if (doc.v !== VERSION || !doc.sections || typeof doc.sections !== "object") return {};
  const out: Record<string, EncodedPage[]> = {};
  for (const [k, pages] of Object.entries(doc.sections)) if (Array.isArray(pages)) out[k] = pages;
  return out;
}

/**
 * `pages` as the section for `langs`, with every other section of `existing`
 * (the file as it is on disk) kept.
 */
export function encodeOcrDoc(langs: OcrLanguages, pages: Iterable<StoredOcrPage>, existing: string | null = null): string {
  const out: EncodedDoc = { v: VERSION, sections: { ...sectionsOf(existing), [langs]: encodePages(pages) } };
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

/** The pages a stored document holds for `langs`; [] when it has none or is unusable. */
export function decodeOcrDoc(json: string, langs: OcrLanguages): StoredOcrPage[] {
  const pages: StoredOcrPage[] = [];
  for (const p of sectionsOf(json)[langs] ?? []) {
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

/** Writes to one file, in order: each reads the file the one before it wrote. */
const writes = new Map<string, Promise<void>>();

export function writeOcrDoc(identity: string, langs: OcrLanguages, pages: Iterable<StoredOcrPage>): Promise<void> {
  const snapshot = [...pages];
  const run = async () => {
    const existing = await invokeCmd<string | null>("ocr_cache_read", { identity }).catch(() => null);
    await invokeCmd<void>("ocr_cache_write", { identity, json: encodeOcrDoc(langs, snapshot, existing) });
  };
  const next = (writes.get(identity) ?? Promise.resolve()).then(run, run);
  const settled = next.catch(() => {});
  writes.set(identity, settled);
  void settled.then(() => {
    if (writes.get(identity) === settled) writes.delete(identity);
  });
  return next;
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
