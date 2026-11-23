/**
 * Deterministic strikethrough safety check for citation and finding verification (28.0).
 *
 * Legal redlines and amended contracts often retain deleted clauses in the PDF
 * text layer — either wrapped in `<s>...</s>` / `~~...~~` by `pdf-inspector`
 * when a line is stroked through the glyphs, or covered by a PDF `/StrikeOut`
 * markup annotation. If an answer states a struck-out term as active fact
 * without disclosing that it was deleted/struck/voided, `withClaim` and
 * `placeFinding` downgrade the check to `mismatch` ("Check the page").
 */
import { docCache } from "./doc-cache";
import type { PdfRect } from "./types";

const DISCLOSED_STRIKE_RE =
  /\b(?:struck(?:\s+out|\s+through)?|strikethrough|deleted?|removed?|crossed\s+out|lined\s+out|redlined?|void(?:ed)?|repealed?|omitted|superseded|cancelled|canceled|rescinded|no\s+longer\s+in\s+effect)\b|删除|删去|划掉|划除|划线删除|作废|废止|失效|已取消/i;

const STRUCK_SPAN_RE = /<(?:s|del|strike)\b[^>]*>([\s\S]*?)<\/(?:s|del|strike)>|~~([^\n~]+?)~~/gi;
const INLINE_TAG_RE = /<\/?(?:u|s|del|strike|br|sup|sub|b|i|em|strong)\s*\/?>/gi;
const FOLD_DROP_RE = /[\s\-\u00AD\u2010-\u2014\u2212*#\\|~='"“”‘’「」『』«»`]/g;

function foldForStrike(text: string): string {
  return text
    .replace(INLINE_TAG_RE, " ")
    .normalize("NFKC")
    .toLowerCase()
    .replace(FOLD_DROP_RE, "");
}

function cleanLabel(raw: string): string {
  const plain = raw.replace(INLINE_TAG_RE, "").replace(/\s+/g, " ").trim();
  const clipped = plain.length > 42 ? `${plain.slice(0, 42)}…` : plain;
  return clipped ? `~~${clipped}~~` : "~~struck-out text~~";
}

function rectsOverlapStrikeOut(quoteRect: PdfRect, strikeRect: PdfRect): boolean {
  const xOverlap =
    Math.min(quoteRect.x + quoteRect.width, strikeRect.x + strikeRect.width) -
    Math.max(quoteRect.x, strikeRect.x);
  if (xOverlap <= 0) return false;
  const minWidth = Math.max(1, Math.min(quoteRect.width, strikeRect.width));
  if (xOverlap < minWidth * 0.35) return false;
  const strikeMidY = strikeRect.y + strikeRect.height / 2;
  const pad = Math.max(2, quoteRect.height * 0.25);
  return strikeMidY >= quoteRect.y - pad && strikeMidY <= quoteRect.y + quoteRect.height + pad;
}

export function claimDisclosesStrikethrough(claim: string): boolean {
  return DISCLOSED_STRIKE_RE.test(claim);
}

export function struckOutMismatch(
  path: string | undefined,
  page: number | undefined,
  rects: readonly PdfRect[] | undefined,
  quote: string | null | undefined,
  claim: string,
): string[] {
  if (!claim || claimDisclosesStrikethrough(claim)) return [];
  const rawQuote = quote ?? "";

  // Direct inline strikethrough markup carried inside `quote` itself.
  STRUCK_SPAN_RE.lastIndex = 0;
  const inlineMatch = STRUCK_SPAN_RE.exec(rawQuote);
  if (inlineMatch) {
    return [cleanLabel(inlineMatch[1] ?? inlineMatch[2] ?? rawQuote)];
  }

  if (!path || !page || page < 1) return [];
  const foldedQuote = foldForStrike(rawQuote);

  // 1. PDF `/StrikeOut` markup annotations overlapping the located text runs.
  const doc = typeof docCache.get === "function" ? docCache.get(path) : undefined;
  if (doc?.annotations?.length) {
    for (const annot of doc.annotations) {
      if (annot.page !== page || annot.subtype !== "StrikeOut") continue;
      const strikeBoxes = annot.rects && annot.rects.length > 0 ? annot.rects : [annot.rect];
      if (
        rects &&
        rects.length > 0 &&
        rects.some((qr) => strikeBoxes.some((sr) => rectsOverlapStrikeOut(qr, sr)))
      ) {
        return [cleanLabel(annot.quoted || rawQuote)];
      }
      if (annot.quoted) {
        const foldedAnnot = foldForStrike(annot.quoted);
        if (
          foldedAnnot.length >= 4 &&
          foldedQuote.length >= 4 &&
          (foldedQuote.includes(foldedAnnot) || foldedAnnot.includes(foldedQuote))
        ) {
          return [cleanLabel(annot.quoted)];
        }
      }
    }
  }

  // 2. Extracted `<s>...</s>` / `~~...~~` spans on the cited page when no
  //    unstruck occurrence of the same quote exists on that page.
  if (foldedQuote.length < 2) return [];
  const pages = typeof docCache.getPages === "function" ? docCache.getPages(path) : (doc?.pages ?? []);
  const pageEntry = pages.find((p) => p.page === page);
  const pageMarkdown = pageEntry?.text ?? "";
  if (!pageMarkdown || (!pageMarkdown.includes("<") && !pageMarkdown.includes("~~"))) {
    return [];
  }

  const struckSpans: Array<{ raw: string; folded: string }> = [];
  STRUCK_SPAN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STRUCK_SPAN_RE.exec(pageMarkdown)) !== null) {
    const inner = m[1] ?? m[2] ?? "";
    const folded = foldForStrike(inner);
    // Catch 2-char surgical legal/financial redlines (`<s>5%</s>`, `<s>30</s>`,
    // `<s>甲方</s>`, `<s>不得</s>`) as well as >=3-char struck phrases (30.0).
    const significantTwoChar =
      folded.length === 2 && /[\d%‰‱一-鿿]/.test(folded);
    if (folded.length >= 3 || significantTwoChar) {
      struckSpans.push({ raw: inner, folded });
    }
  }
  if (struckSpans.length === 0) return [];

  const overlapsBoundary = (a: string, b: string): boolean => {
    if (a.includes(b) || b.includes(a)) return true;
    const minOverlap = Math.min(a.length, b.length, 6);
    if (minOverlap < 4) return false;
    for (let len = Math.min(a.length, b.length); len >= minOverlap; len -= 1) {
      if (a.endsWith(b.slice(0, len)) || b.endsWith(a.slice(0, len))) return true;
    }
    return false;
  };

  const hit = struckSpans.find((s) => overlapsBoundary(foldedQuote, s.folded));
  if (!hit) return [];

  const unstruckMarkdown = pageMarkdown.replace(STRUCK_SPAN_RE, " ");
  const unstruckFolded = foldForStrike(unstruckMarkdown);
  if (unstruckFolded.includes(foldedQuote)) return [];

  return [cleanLabel(hit.raw)];
}
