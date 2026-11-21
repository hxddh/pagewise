/**
 * Deterministic quantity, unit, basis-point, number-word, and calendar-date
 * extraction and comparison for citation verification.
 */

export type QuantityKind = "" | "%" | "‰" | "‱";
export type Dimension =
  | "month"
  | "day"
  | "hour"
  | "minute"
  | "time"
  | "date"
  | "yuan"
  | "usd"
  | "eur"
  | "gbp"
  | null;

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

const EN_ONES: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const EN_TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const EN_MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
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

export function englishNumeral(raw: string): number | null {
  const clean = raw.toLowerCase().trim().replace(/-/g, " ").replace(/\s+/g, " ");
  if (clean in EN_ONES) return EN_ONES[clean]!;
  if (clean in EN_TENS) return EN_TENS[clean]!;
  const parts = clean.split(" ");
  if (parts.length === 2 && parts[0]! in EN_TENS && parts[1]! in EN_ONES && EN_ONES[parts[1]!]! < 10) {
    return EN_TENS[parts[0]!]! + EN_ONES[parts[1]!]!;
  }
  return null;
}

// Sub-month fixed durations normalize to seconds under `"time"`, so
// `3 days === 72 hours`, `2 hours === 120 minutes`, and `1.8 ms !== 1.8 s`.
const UNITS: Array<[RegExp, Dimension, number]> = [
  [/^个?工作日/, null, 1],
  [/^business\s+days?\b/i, null, 1],
  [/^个月/, "month", 1],
  [/^(?:months?)\b/i, "month", 1],
  [/^年/, "month", 12],
  [/^(?:years?|yrs?)\b/i, "month", 12],
  [/^个?季度/, "month", 3],
  [/^quarters?\b/i, "month", 3],
  [/^(?:周|星期|weeks?\b)/i, "time", 7 * 86_400],
  [/^(?:自然日|日历日|日|天|calendar\s+days?\b|days?\b)/i, "time", 86_400],
  [/^(?:个?小时|hours?\b|hrs?\b)/i, "time", 3_600],
  [/^(?:分钟|minutes?\b|mins?\b)/i, "time", 60],
  [/^(?:毫秒|milliseconds?\b|ms\b)/i, "time", 0.001],
  [/^(?:秒钟?|seconds?\b|secs?\b|s\b(?![a-z]))/i, "time", 1],
  [/^亿元/, "yuan", 1e8],
  [/^万元/, "yuan", 1e4],
  [/^(?:元|rmb\b|cny\b)/i, "yuan", 1],
  [/^(?:dollars?|usd)\b/i, "usd", 1],
  [/^(?:euros?|eur)\b/i, "eur", 1],
  [/^(?:pounds?|gbp)\b/i, "gbp", 1],
];

const CN_FOLLOW = /^(?:个?工作日|个月|个?季度|年|周|星期|日|天|个?小时|学时|分钟|秒钟?|毫秒|亿元|万元|元|个?基点|份|次|期|倍|名|台|套|项|人|页|条|款|%)/;
const EN_WORD_UNIT_FOLLOW =
  /^\s*(?:\(\s*\d+\s*\)\s*)?(?:business\s+days?|calendar\s+days?|years?|months?|quarters?|weeks?|days?|hours?|minutes?|seconds?|percent\b|per\s+cent\b|basis\s+points?\b|bps\b|dollars?|usd\b|euros?|eur\b|pounds?|gbp\b|million\b|billion\b|thousand\b)/i;

function unitAfter(rest: string): [Dimension, number] {
  const r = rest.replace(/^\s+/, "");
  for (const [re, dim, factor] of UNITS) if (re.test(r)) return [dim, factor];
  return [null, 1];
}

function isBasisPointsAfter(rest: string): boolean {
  return /^\s*(?:bps\b|basis\s+points?\b|个?基点)/i.test(rest);
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

function isRangeDashAfterNumber(text: string, signPos: number, signChar: string): boolean {
  if (signChar !== "-" && signChar !== "\u2013") return false;
  const before = text.slice(Math.max(0, signPos - 16), signPos);
  // `"10 –15%"` or `"10 -15%"` after a number (and not `"from -15%"`) is a range upper bound.
  return /\d\s*(?:%|‰|‱)?\s*$/.test(before);
}

function hasValidNegativeBoundary(text: string, signPos: number, signChar: string): boolean {
  if (isRangeDashAfterNumber(text, signPos, signChar)) return false;
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

const ISO_DATE_RE = /\b(19\d{2}|20\d{2}|2100)[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/g;
const ZH_DATE_RE =
  /((?:19|20)\d{2}|[零〇一二三四五六七八九]{4})\s*年\s*(1[0-2]|0?[1-9]|十[一二]?|[一二三四五六七八九])\s*月\s*(3[01]|[12]\d|0?[1-9]|[一二三]?十[一二三四五六七八九]?|[一二三四五六七八九])\s*[日号]/g;
const EN_MDY_DATE_RE =
  /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?,\s*(19\d{2}|20\d{2}|2100)\b/gi;
const EN_DMY_DATE_RE =
  /\b(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?\s+(?:of\s+)?(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?,?\s+(19\d{2}|20\d{2}|2100)\b/gi;

const EN_WORD_RE =
  /\b((?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\s]+(?:one|two|three|four|five|six|seven|eight|nine))?|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|one|two|three|four|five|six|seven|eight|nine)\b/gi;

const NUMBER_RE =
  /(?:([+\-\u2212\u2013])(?=\S))?(?:(USD|US\$|EUR|GBP|RMB|CNY|人民币|[$€£¥￥])\s*)?(?:([+\-\u2212\u2013])(?=\d))?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s*([万亿])(?!元)|\s+(thousand|million|billion|trillion)\b|([kKmMbBtT])\b)?\s*(%|‰|‱|percent\b|per\s+cent\b)?/gi;

function parseIntOrCn(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : chineseNumeral(raw);
}

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
    if (!kind && isBasisPointsAfter(rest)) {
      [value, kind] = [value / 100, "%"];
    } else if (kind === "‰") {
      [value, kind] = [value / 10, "%"];
    } else if (kind === "‱") {
      [value, kind] = [value / 100, "%"];
    }
    let dimension: Dimension = null;
    let factor = 1;
    if (!kind) {
      if (forcedDim === "date") {
        dimension = "date";
      } else {
        const [postDim, postFactor] = unitAfter(rest);
        if (forcedDim !== null) {
          dimension = forcedDim;
          factor = postDim === forcedDim ? postFactor : 1;
        } else {
          dimension = postDim;
          factor = postFactor;
        }
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

  const pushDate = (start: number, end: number, y: number, m: number, d: number) => {
    if (overlaps(start, end) || y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return;
    const encoded = y * 10_000 + m * 100 + d;
    push(start, end, encoded, "", "", "date");
    // In passage context (`implicit: true`), a full date also substantiates its
    // standalone calendar year (e.g. "协议于二〇二五年生效" against "2025年1月1日").
    if (options.implicit) {
      out.push({ value: y, kind: "", dimension: "month", base: y * 12, text: String(y) });
      out.push({ value: y, kind: "", dimension: null, base: y, text: String(y) });
    }
  };

  // Calendar dates first so `2025-04-17`, `2025年4月17日`, and `April 17, 2025`
  // compare as one canonical date instead of misparsing `2025年` as 24,300 months.
  for (const m of text.matchAll(ISO_DATE_RE)) {
    pushDate(m.index!, m.index! + m[0].length, Number(m[1]), Number(m[2]), Number(m[3]));
  }
  for (const m of text.matchAll(ZH_DATE_RE)) {
    const y = parseIntOrCn(m[1]!);
    const mo = parseIntOrCn(m[2]!);
    const d = parseIntOrCn(m[3]!);
    if (y !== null && mo !== null && d !== null) {
      pushDate(m.index!, m.index! + m[0].length, y, mo, d);
    }
  }
  for (const m of text.matchAll(EN_MDY_DATE_RE)) {
    const mo = EN_MONTHS[m[1]!.toLowerCase().replace(/\.$/, "")];
    if (mo) pushDate(m.index!, m.index! + m[0].length, Number(m[3]), mo, Number(m[2]));
  }
  for (const m of text.matchAll(EN_DMY_DATE_RE)) {
    const mo = EN_MONTHS[m[2]!.toLowerCase().replace(/\.$/, "")];
    if (mo) pushDate(m.index!, m.index! + m[0].length, Number(m[3]), mo, Number(m[1]));
  }

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

    const prefixDim =
      currRaw && (!/[A-Za-z]/.test(currRaw[0]!) || matchStart === 0 || !/[A-Za-z]/.test(text[matchStart - 1]!))
        ? currencyFromPrefix(currRaw)
        : null;

    let sign = 1;
    let effectiveStart = matchStart;
    if (innerSign) {
      if (innerSign !== "+") sign = -1;
    } else if (outerSign) {
      if (hasValidNegativeBoundary(text, matchStart, outerSign)) {
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
    push(effectiveStart, end, value, kind, text.slice(end, end + 20), prefixDim);
  }
  for (const m of text.matchAll(new RegExp(`[${CN}]+`, "g"))) {
    const start = m.index!;
    const end = start + m[0].length;
    const rest = text.slice(end, end + 10);
    if (!CN_FOLLOW.test(rest) || /分之$/.test(text.slice(Math.max(0, start - 2), start))) continue;
    const value = chineseNumeral(m[0]);
    if (value !== null && value > 0) push(start, end, value, "", rest);
  }
  // English number words when followed by an explicit quantity unit ("fifteen business days", "thirty percent").
  for (const m of text.matchAll(EN_WORD_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    const afterRaw = text.slice(end, end + 32);
    if (!EN_WORD_UNIT_FOLLOW.test(afterRaw)) continue;
    const val = englishNumeral(m[0]);
    if (val === null) continue;
    const strippedAfter = afterRaw.replace(/^\s*\(\s*\d+\s*\)\s*/, " ");
    if (/^\s*(?:percent\b|per\s+cent\b)/i.test(strippedAfter)) {
      push(start, end, val, "%", "");
    } else if (/^\s*(?:million|billion|thousand)\b/i.test(strippedAfter)) {
      const scWord = /^\s*(million|billion|thousand)\b/i.exec(strippedAfter)![1]!.toLowerCase();
      const restAfterScale = strippedAfter.replace(/^\s*(?:million|billion|thousand)\b/i, "");
      push(start, end, val * (EN_SCALE[scWord] ?? 1), "", restAfterScale);
    } else {
      push(start, end, val, "", strippedAfter);
    }
  }

  // Propagate shared trailing `%` or unit across range pairs (`10–15%`, `10 to 15 days`, `10至15万元`).
  for (let i = 0; i + 1 < out.length; i += 1) {
    const a = out[i]!;
    const b = out[i + 1]!;
    if (a.kind !== "" || a.dimension !== null) continue;
    if (b.kind === "" && b.dimension === null) continue;
    const aAt = text.indexOf(a.text);
    const bAt = aAt >= 0 ? text.indexOf(b.text, aAt + a.text.length) : -1;
    if (aAt < 0 || bAt < 0) continue;
    const between = text.slice(aAt + a.text.length, bAt);
    if (/^\s*(?:[-–—~]|至|到|\bto\b|\band\b)\s*$/i.test(between)) {
      if (b.kind !== "") {
        a.kind = b.kind;
        // Match b's scaling (e.g. `‰` already divided by 10, `bps` divided by 100)
        if (b.text.includes("‰")) a.value /= 10;
        else if (b.text.includes("‱")) a.value /= 100;
        else if (isBasisPointsAfter(text.slice(bAt + b.text.length, bAt + b.text.length + 18))) a.value /= 100;
        a.base = a.value;
      } else if (b.dimension !== null && b.value !== 0) {
        const factor = b.base / b.value;
        a.dimension = b.dimension;
        a.base = a.value * factor;
      }
    }
  }

  return out;
}

function same(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

export function statedIn(q: Quantity, context: readonly Quantity[]): boolean {
  return context.some((c) => {
    if (c.kind !== q.kind) return false;
    if (q.dimension === "date" || c.dimension === "date") {
      return q.dimension === "date" && c.dimension === "date" && same(c.base, q.base);
    }
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
