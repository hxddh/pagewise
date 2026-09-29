/**
 * The quantities a sentence asserts, in a form two wordings can be compared
 * in (15.0).
 *
 * A citation can be on its page and the sentence it supports still be wrong —
 * most dangerously in a number: 24 months for 三十六个月, 千分之三 for 万分之三.
 * `citation-check.ts` compares the quantities of the sentence with those of
 * the passage the quote was found in. This file only reads quantities; it
 * never decides anything.
 *
 * Deliberately narrow. What it reads, it reads exactly; what it cannot read
 * reliably, it does not read at all, so it can never be the reason a correct
 * sentence is flagged:
 *
 *   - Arabic numbers, with thousands separators and decimals;
 *   - Chinese numerals, lower and upper case (三十六, 肆佰叁拾陆万捌仟), only
 *     where a unit follows (个月, 日, 元, …) or 百分之/千分之/万分之 precedes —
 *     a bare 一 is as often a word (统一, 一方) as a number;
 *   - percent, per mille and per ten thousand, in either spelling;
 *   - units of time and money, so 三年 and 36 个月, or 436.8 万元 and
 *     4,368,000 元, are the same amount.
 *
 * Number words (three, thirty-six) are not read: an English sentence that
 * spells its numbers is not checked, rather than checked badly.
 */

export type QuantityKind = "" | "%" | "‰" | "‱";
export type Dimension = "month" | "day" | "hour" | "minute" | "yuan" | null;

export interface Quantity {
  value: number;
  kind: QuantityKind;
  /** What the unit measures, and the value in its base unit (months, days, …). */
  dimension: Dimension;
  base: number;
  /** As written, for telling the reader which number it was. */
  text: string;
}

const DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 肆: 4,
  五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
};
const SMALL: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };
const LARGE: Record<string, number> = { 万: 1e4, 亿: 1e8 };
const CN = "零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟";

/** A Chinese numeral as a number, or null when it is not one. */
export function chineseNumeral(s: string): number | null {
  let total = 0;
  let section = 0;
  let digit = 0;
  let any = false;
  for (const ch of s) {
    if (ch in DIGIT) {
      digit = DIGIT[ch]!;
      any = true;
    } else if (ch in SMALL) {
      section += (digit || 1) * SMALL[ch]!;
      digit = 0;
      any = true;
    } else if (ch in LARGE) {
      total += (section + digit) * LARGE[ch]!;
      section = 0;
      digit = 0;
      any = true;
    } else {
      return null;
    }
  }
  return any ? total + section + digit : null;
}

/** Units that follow a number, longest first, with what they measure. */
const UNITS: Array<[RegExp, Dimension, number]> = [
  [/^个?工作日/, null, 1], // working days are not calendar days; compared as themselves
  [/^个月/, "month", 1],
  [/^(?:months?)\b/i, "month", 1],
  [/^年/, "month", 12],
  [/^(?:years?)\b/i, "month", 12],
  [/^(?:周|星期|weeks?\b)/i, "day", 7],
  [/^(?:日|天|days?\b)/i, "day", 1],
  [/^(?:个?小时|hours?\b)/i, "hour", 1],
  [/^(?:分钟|minutes?\b)/i, "minute", 1],
  [/^亿元/, "yuan", 1e8],
  [/^万元/, "yuan", 1e4],
  [/^元/, "yuan", 1],
];

/** Units after which a Chinese numeral is certainly a number. */
const CN_FOLLOW = /^(?:个?工作日|个月|年|周|星期|日|天|个?小时|学时|分钟|亿元|万元|元|份|次|期|倍|名|台|套|项|人|页|条|款|%)/;

function unitAfter(rest: string): [Dimension, number] {
  const r = rest.replace(/^\s+/, "");
  for (const [re, dim, factor] of UNITS) if (re.test(r)) return [dim, factor];
  return [null, 1];
}

/**
 * Page references say where, not how much, and the passage a quote is in
 * almost never repeats them: they are not read.
 */
function withoutReferences(text: string): string {
  return text
    .replace(/第\s*[\d一二三四五六七八九十百]+\s*页/g, " ")
    .replace(/\bpp?\.\s*\d+(?:\s*[-–]\s*\d+)?/gi, " ")
    .replace(/\bpages?\s+\d+(?:\s*(?:[-–]|and|to)\s*\d+)?/gi, " ");
}

export function quantities(input: string): Quantity[] {
  const text = withoutReferences(input.normalize("NFKC"));
  const out: Quantity[] = [];
  const taken: Array<[number, number]> = [];
  const overlaps = (a: number, b: number) => taken.some(([s, e]) => a < e && b > s);
  const push = (start: number, end: number, value: number, kind: QuantityKind, rest: string) => {
    if (!Number.isFinite(value) || overlaps(start, end)) return;
    taken.push([start, end]);
    const [dimension, factor] = kind ? [null, 1] : unitAfter(rest);
    out.push({ value, kind, dimension, base: value * factor, text: text.slice(start, end).trim() });
  };

  // 百分之三 / 千分之3 — fractions spelled out.
  for (const m of text.matchAll(new RegExp(`(百|千|万)分之\\s*([${CN}]+|\\d+(?:\\.\\d+)?)`, "g"))) {
    const v = /\d/.test(m[2]!) ? Number(m[2]) : chineseNumeral(m[2]!);
    const kind = ({ 百: "%", 千: "‰", 万: "‱" } as const)[m[1] as "百" | "千" | "万"];
    if (v !== null) push(m.index!, m.index! + m[0].length, v, kind, "");
  }
  // Arabic numbers, with a following % or unit.
  for (const m of text.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(%|‰|‱)?/g)) {
    const value = Number(m[1]!.replace(/,/g, "") + (m[2] ?? ""));
    const end = m.index! + m[0].length;
    push(m.index!, end, value, (m[3] ?? "") as QuantityKind, text.slice(end, end + 8));
  }
  // Chinese numerals, where what follows makes them numbers.
  for (const m of text.matchAll(new RegExp(`[${CN}]+`, "g"))) {
    const start = m.index!;
    const end = start + m[0].length;
    const rest = text.slice(end, end + 8);
    // 万元 / 亿元 end a number rather than being part of it when a unit follows.
    let word = m[0];
    let tail = rest;
    const money = /[万亿]$/.test(word) && tail.startsWith("元");
    if (money) {
      tail = word.slice(-1) + tail;
      word = word.slice(0, -1);
    }
    if (!CN_FOLLOW.test(tail) || /分之$/.test(text.slice(Math.max(0, start - 2), start))) continue;
    const value = chineseNumeral(word);
    if (value !== null && value > 0) push(start, start + word.length, value, "", tail);
  }
  return out;
}

/** Whether `q` is stated, in any spelling or unit, among `context`. */
export function statedIn(q: Quantity, context: readonly Quantity[]): boolean {
  return context.some((c) => {
    if (c.kind !== q.kind) return false;
    if (c.value === q.value) return true;
    // The same amount in another unit of the same dimension: 三年 and 36 个月.
    return q.dimension !== null && c.dimension === q.dimension && Math.abs(c.base - q.base) < 1e-6 * Math.max(1, q.base);
  });
}

/**
 * The quantities of `claim` that `context` does not state. Empty when every
 * number in the claim is in the passage — including when the claim has none.
 */
export function unstatedQuantities(claim: string, context: string): Quantity[] {
  const ctx = quantities(context);
  return quantities(claim).filter((q) => !statedIn(q, ctx));
}
