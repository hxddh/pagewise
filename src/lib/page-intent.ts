/** User refers to the page currently open in the preview. */
export function hasCurrentPageIntent(text: string): boolean {
  return /这一页|当前页|本页|此页|这页|this page|current page|the page (?:i'?m|I'?m|I'm) (?:viewing|on|reading)/i.test(
    text,
  );
}

/** User wants the whole document, not a single page. */
export function hasWholeDocumentIntent(text: string): boolean {
  return /全文|整份|整个文档|整篇|所有页|全书|whole document|entire document|full document|all pages|document summary|总结(?:一下)?(?:这份|这个|整|全)|分析(?:一下)?(?:这份|这个|整|全)/i.test(
    text,
  );
}

const CN_DIGIT: Record<string, number> = {
  "零": 0,
  "〇": 0,
  "一": 1,
  "二": 2,
  "两": 2,
  "三": 3,
  "四": 4,
  "五": 5,
  "六": 6,
  "七": 7,
  "八": 8,
  "九": 9,
};
const CN_UNIT: Record<string, number> = { "十": 10, "百": 100, "千": 1000 };
const CN_CHARS = "零〇一二两三四五六七八九十百千";

/** Convert full-width digits (０-９) to their ASCII equivalents. */
function normalizeDigits(s: string): string {
  return s.replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10));
}

/** Parse a Chinese numeral string (e.g. 十二, 二十三, 一百二十三) to an int. */
function chineseToInt(s: string): number | null {
  let section = 0;
  let number = 0;
  let sawAny = false;
  for (const ch of s) {
    if (ch in CN_DIGIT) {
      number = CN_DIGIT[ch]!;
      sawAny = true;
    } else if (ch in CN_UNIT) {
      const unit = CN_UNIT[ch]!;
      section += (number === 0 ? 1 : number) * unit;
      number = 0;
      sawAny = true;
    } else {
      return null;
    }
  }
  return sawAny ? section + number : null;
}

/** Parse a token that may be ASCII/full-width digits or Chinese numerals. */
function parseNumToken(tok: string): number | null {
  const norm = normalizeDigits(tok);
  if (/^\d+$/.test(norm)) {
    const n = parseInt(norm, 10);
    return Number.isFinite(n) ? n : null;
  }
  return chineseToInt(tok);
}

const MAX_RANGE_SPAN = 200;

export function extractExplicitPageNumbers(text: string): number[] {
  const found = new Set<number>();

  const addNum = (tok: string): void => {
    const n = parseNumToken(tok);
    if (n !== null && n > 0) found.add(n);
  };
  const addRange = (a: string, b: string): void => {
    const lo = parseNumToken(a);
    const hi = parseNumToken(b);
    if (lo !== null && hi !== null && lo > 0 && hi >= lo && hi - lo <= MAX_RANGE_SPAN) {
      for (let i = lo; i <= hi; i++) found.add(i);
      return;
    }
    if (lo !== null && lo > 0) found.add(lo);
    if (hi !== null && hi > 0) found.add(hi);
  };

  // Regexes are rebuilt per call so the /g lastIndex is never shared across calls.
  const numTok = `[0-9０-９${CN_CHARS}]+`;

  const rangePatterns = [
    new RegExp(`第\\s*(${numTok})\\s*(?:到|至|-|~|—|－)\\s*(${numTok})\\s*页`, "g"),
    /pages?\s*(\d{1,4})\s*(?:-|–|—|~|to)\s*(\d{1,4})/gi,
  ];
  for (const re of rangePatterns) {
    for (const match of text.matchAll(re)) addRange(match[1]!, match[2]!);
  }

  const singlePatterns = [
    new RegExp(`第\\s*(${numTok})\\s*页`, "g"),
    /pages?\s*(\d{1,4})/gi,
    /\bp\.\s*(\d{1,4})\b/gi,
    /\bp\s*(\d{1,4})\b/gi,
  ];
  for (const re of singlePatterns) {
    for (const match of text.matchAll(re)) addNum(match[1]!);
  }

  return [...found];
}

export interface FollowPageContext {
  userText: string;
  viewingPage: number;
}

/** Whether follow-agent should jump preview to a page the agent just read. */
export function shouldFollowAgentToPage(
  readPage: number,
  ctx: FollowPageContext | null,
): boolean {
  if (!ctx) return true;

  const { userText, viewingPage } = ctx;

  if (hasWholeDocumentIntent(userText)) return false;

  if (hasCurrentPageIntent(userText)) {
    return readPage === viewingPage;
  }

  if (extractExplicitPageNumbers(userText).length > 0) {
    return false;
  }

  return readPage === viewingPage;
}
