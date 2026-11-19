/**
 * Deterministic quantity extraction and comparison for citation verification.
 */

export type QuantityKind = "" | "%" | "‰" | "‱";
export type Dimension = "month" | "day" | "hour" | "minute" | "yuan" | "usd" | "eur" | "gbp" | null;

export interface Quantity {
  value: number;
  kind: QuantityKind;
  dimension: Dimension;
  base: number;
  text: string;
}

const DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 肆: 4,
  五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
};
const SMALL: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };
const LARGE: Record<string, number> = { 万: 1e4, 亿: 1e8 };
const CN = "零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟";

const EN_SCALE: Record<string, number> = {
  thousand: 1e3,
  million: 1e6,
  billion: 1e9,
  trillion: 1e12,
};

const SHORT_SCALE: Record<string, number> = {
  k: 1e3,
  m: 1e6,
  b: 1e9,
  t: 1e12,
};

export function chineseNumeral(s: string): number | null {
  const chars = [...s];
  if (chars.length > 1 && chars.every((ch) => ch in DIGIT)) {
    return Number(chars.map((ch) => DIGIT[ch]).join(""));
  }
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

const UNITS: Array<[RegExp, Dimension, number]> = [
  [/^个?工作日/, null, 1],
  [/^个月/, "month", 1],
  [/^(?:months?)\b/i, "month", 1],
  [/^年/, "month", 12],
  [/^(?:years?)\b/i, "month", 12],
  [/^个?季度/, "month", 3],
  [/^(?:周|星期|weeks?\b)/i, "day", 7],
  [/^(?:日|天|days?\b)/i, "day", 1],
  [/^(?:个?小时|hours?\b)/i, "hour", 1],
  [/^(?:分钟|minutes?\b)/i, "minute", 1],
  [/^亿元/, "yuan", 1e8],
  [/^万元/, "yuan", 1e4],
  [/^(?:元|rmb\b|cny\b)/i, "yuan", 1],
  [/^(?:dollars?|usd)\b/i, "usd", 1],
  [/^(?:euros?|eur)\b/i, "eur", 1],
  [/^(?:pounds?|gbp)\b/i, "gbp", 1],
];

const CN_FOLLOW = /^(?:个?工作日|个月|个?季度|年|周|星期|日|天|个?小时|学时|分钟|亿元|万元|元|份|次|期|倍|名|台|套|项|人|页|条|款|%)/;

function unitAfter(rest: string): [Dimension, number] {
  const r = rest.replace(/^\s+/, "");
  for (const [re, dim, factor] of UNITS) if (re.test(r)) return [dim, factor];
  return [null, 1];
}

function currencyFromPrefix(raw: string | undefined): Dimension {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();
  if (s === "$" || s === "USD" || s === "US$") return "usd";
  if (s === "€" || s === "EUR") return "eur";
  if (s === "£" || s === "GBP") return "gbp";
  if (s === "¥" || s === "￥" || s === "RMB" || s === "CNY" || s === "人民币") return "yuan";
  return null;
}

function hasValidNegativeBoundary(text: string, signPos: number): boolean {
  if (signPos <= 0) return true;
  const prev = text[signPos - 1]!;
  return /[\s(（[{<:;=,，；：±]/.test(prev);
}

function withoutReferences(text: string): string {
  return text
    .replace(/第\s*[\d一二三四五六七八九十百]+\s*页/g, " ")
    .replace(/第\s*[\d零〇一二三四五六七八九十百.]+\s*(?:条款|条|款|项|章|节|部分)/g, " ")
    .replace(
      /(?:\b(?:sections?|clauses?|articles?|sec\.)|§)\s*\d+(?:\.\d+)*(?:\s*(?:,|and|or|to|through|[-–])\s*(?:and\s+)?\d+(?:\.\d+)*)*/gi,
      " ",
    )
    .replace(/\bpp?\.\s*\d+(?:\s*[-–]\s*\d+)?/gi, " ")
    .replace(/\bpages?\s+\d+(?:\s*(?:[-–]|and|to)\s*\d+)?/gi, " ");
}

const IMPLICIT: Array<[RegExp, number]> = [
  [/每个?季度|按季度?/g, 3],
  [/每个?月|按月/g, 1],
  [/每一?年|按年/g, 12],
];

const NUMBER_RE =
  /(?:([+\-\u2212\u2013])(?=\S))?(?:(USD|US\$|EUR|GBP|RMB|CNY|人民币|[$€£¥￥])\s*)?(?:([+\-\u2212\u2013])(?=\d))?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s*([万亿])(?!元)|\s+(thousand|million|billion|trillion)\b|([kKmMbBtT])\b)?\s*(%|‰|‱|percent\b|per\s+cent\b)?/gi;

export function quantities(input: string, options: { implicit?: boolean } = {}): Quantity[] {
  const text = withoutReferences(input.normalize("NFKC"));
  const out: Quantity[] = [];
  const taken: Array<[number, number]> = [];
  const overlaps = (a: number, b: number) => taken.some(([s, e]) => a < e && b > s);
  const push = (
    start: number,
    end: number,
    value: number,
    kind: QuantityKind,
    rest: string,
    forcedDim: Dimension = null,
  ) => {
    if (!Number.isFinite(value) || overlaps(start, end)) return;
    taken.push([start, end]);
    if (kind === "‰") [value, kind] = [value / 10, "%"];
    else if (kind === "‱") [value, kind] = [value / 100, "%"];
    let dimension: Dimension = null;
    let factor = 1;
    if (!kind) {
      const [postDim, postFactor] = unitAfter(rest);
      if (forcedDim !== null) {
        dimension = forcedDim;
        factor = postDim === forcedDim ? postFactor : 1;
      } else {
        dimension = postDim;
        factor = postFactor;
      }
    }
    out.push({
      value,
      kind,
      dimension,
      base: value * factor,
      text: text.slice(start, end).trim(),
    });
  };

  if (options.implicit) {
    for (const [re, months] of IMPLICIT) {
      for (const m of text.matchAll(re)) {
        out.push({ value: months, kind: "", dimension: "month", base: months, text: m[0] });
      }
    }
  }
  for (const m of text.matchAll(new RegExp(`(百|千|万)分之\\s*([${CN}]+|\\d+(?:\\.\\d+)?)`, "g"))) {
    const v = /\d/.test(m[2]!) ? Number(m[2]) : chineseNumeral(m[2]!);
    const kind = ({ 百: "%", 千: "‰", 万: "‱" } as const)[m[1] as "百" | "千" | "万"];
    if (v !== null) push(m.index!, m.index! + m[0].length, v, kind, "");
  }
  for (const m of text.matchAll(new RegExp(`(\\d+|[${CN}]+)?\\s*(个月|年)半|半\\s*(个月|年)`, "g"))) {
    const whole = m[1] ? (/\d/.test(m[1]) ? Number(m[1]) : chineseNumeral(m[1])) : 0;
    if (whole === null) continue;
    const unit = m[2] ?? m[3]!;
    push(m.index!, m.index! + m[0].length, whole + 0.5, "", unit);
  }
  for (const m of text.matchAll(NUMBER_RE)) {
    const matchStart = m.index!;
    const outerSign = m[1];
    const currRaw = m[2];
    const innerSign = m[3];
    const intPart = m[4]!;
    const decPart = m[5] ?? "";
    const cnScale = m[6];
    const enScale = m[7];
    const shortScale = m[8];
    const pctRaw = m[9];

    // If currency word like USD/EUR/GBP/RMB/CNY was glued onto a preceding letter ("XUSD 5"), ignore prefix.
    const prefixDim =
      currRaw && (!/[A-Za-z]/.test(currRaw[0]!) || matchStart === 0 || !/[A-Za-z]/.test(text[matchStart - 1]!))
        ? currencyFromPrefix(currRaw)
        : null;

    let sign = 1;
    let effectiveStart = matchStart;
    if (innerSign) {
      if (innerSign !== "+") sign = -1;
    } else if (outerSign) {
      if (hasValidNegativeBoundary(text, matchStart)) {
        if (outerSign !== "+") sign = -1;
      } else {
        effectiveStart = matchStart + outerSign.length;
      }
    }

    let scale = 1;
    let end = matchStart + m[0].length;
    if (cnScale === "亿") scale = 1e8;
    else if (cnScale === "万") scale = 1e4;
    else if (enScale) scale = EN_SCALE[enScale.toLowerCase()] ?? 1;
    else if (shortScale) {
      if (prefixDim !== null) {
        scale = SHORT_SCALE[shortScale.toLowerCase()] ?? 1;
      } else {
        // Without a currency prefix, "4k" or "5m" might be meters/4K/units — leave suffix out of number.
        end -= shortScale.length + (pctRaw ? m[0].slice(m[0].lastIndexOf(shortScale) + shortScale.length).length : 0);
      }
    }

    const value = sign * Number(intPart.replace(/,/g, "") + decPart) * scale;
    const kind = (shortScale && prefixDim === null
      ? ""
      : pctRaw
        ? /^p/i.test(pctRaw)
          ? "%"
          : pctRaw
        : "") as QuantityKind;
    push(effectiveStart, end, value, kind, text.slice(end, end + 12), prefixDim);
  }
  for (const m of text.matchAll(new RegExp(`[${CN}]+`, "g"))) {
    const start = m.index!;
    const end = start + m[0].length;
    const rest = text.slice(end, end + 8);
    if (!CN_FOLLOW.test(rest) || /分之$/.test(text.slice(Math.max(0, start - 2), start))) continue;
    const value = chineseNumeral(m[0]);
    if (value !== null && value > 0) push(start, end, value, "", rest);
  }
  return out;
}

function same(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

export function statedIn(q: Quantity, context: readonly Quantity[]): boolean {
  return context.some((c) => {
    if (c.kind !== q.kind) return false;
    if (q.dimension !== null && c.dimension !== null) {
      return q.dimension === c.dimension && same(c.base, q.base);
    }
    return same(c.value, q.value) || same(c.base, q.base);
  });
}

export function unstatedQuantities(claim: string, context: string): Quantity[] {
  const ctx = quantities(context, { implicit: true });
  return quantities(claim).filter((q) => !statedIn(q, ctx));
}
