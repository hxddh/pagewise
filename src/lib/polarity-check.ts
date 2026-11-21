/**
 * Deterministic, high-precision semantic contradiction checks between a cited
 * claim sentence and the local passage around its located quote (26.0).
 *
 * Designed around zero-false-alarm discipline: a contradiction is reported ONLY
 * when both the claim and the passage contain explicit, anchored opposite poles
 * (e.g. prohibition vs permission on the same verb, lower-bound vs upper-bound
 * comparator on the same figure, "within N days" vs "after N days", "increased"
 * vs "decreased" on the same figure, or swapped contract parties on the same
 * obligation when the passage names only one party).
 */
import { quantities, statedIn } from "./quantities";

const CONDITIONAL_ESCAPE_EN = /\b(?:unless|except|provided\s+that|save\s+where|other\s+than)\b/i;
const CONDITIONAL_ESCAPE_ZH = /(?:除非|但书|但.*除外|另有约定除外|经.*同意除外)/;

interface LexicalPair {
  label: string;
  neg: RegExp;
  pos: RegExp;
}

const LEXICAL_ANTONYMS: readonly LexicalPair[] = [
  {
    label: "non-refundable ↔ refundable",
    neg: /\b(?:non-refundable|not\s+refundable)\b|不可退还|不予退还|概不退还/i,
    pos: /(?<!\bnon-)(?<!\bnot\s)\brefundable\b|(?<![不未])可退还|予以退还/i,
  },
  {
    label: "irrevocable ↔ revocable",
    neg: /\b(?:irrevocable|not\s+revocable)\b|不可撤销/i,
    pos: /(?<!\bnot\s)\brevocable\b|(?<![不未])可撤销/i,
  },
  {
    label: "non-transferable ↔ transferable",
    neg: /\b(?:non-transferable|non-assignable|not\s+transferable|not\s+assignable)\b|不得转让|不可转让/i,
    pos: /(?<!\bnon-)(?<!\bnot\s)\b(?:transferable|assignable)\b|(?<!不得|不可)可以?转让/i,
  },
  {
    label: "exclusive ↔ non-exclusive",
    neg: /\bnon-exclusive\b|非独家|非排他/i,
    pos: /(?<!\bnon-)\bexclusive\b|(?<!非)(?:独家|排他)/i,
  },
];

function verbStemEn(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= 4) return w;
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("es") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 4) return w.slice(0, -1);
  return w;
}

const EN_STOP_VERBS = new Set(["have", "been", "make", "take", "give", "this", "that", "with", "from"]);

function extractModalVerbsEn(text: string, re: RegExp): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(re)) {
    const raw = m[1]?.toLowerCase() ?? "";
    if (raw.length >= 4 && !EN_STOP_VERBS.has(raw)) out.add(verbStemEn(raw));
  }
  return out;
}

function extractModalVerbsZh(text: string, re: RegExp): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(re)) {
    const v = m[1];
    if (v && v.length >= 2) out.add(v.slice(0, 2));
  }
  return out;
}

const EN_PROHIBIT_VERB =
  /\b(?:shall\s+not|must\s+not|may\s+not|cannot|can't|is\s+not\s+permitted\s+to|are\s+not\s+permitted\s+to|is\s+prohibited\s+from|are\s+prohibited\s+from)\s+(?:be\s+)?([a-z]{4,})\b/gi;
const EN_PERMIT_VERB =
  /(?<!\bnot\s)\b(?:may|can|is\s+permitted\s+to|are\s+permitted\s+to|is\s+entitled\s+to|are\s+entitled\s+to|has\s+the\s+right\s+to|have\s+the\s+right\s+to)\s+(?:freely\s+|be\s+)?([a-z]{4,})\b/gi;

const ZH_PROHIBIT_VERB = /(?:不得|禁止|严禁|无权)\s*([一-鿿]{2,4})/g;
const ZH_PERMIT_VERB = /(?<!不得|禁止|严禁|无|不)(?:有权|可以|允许|准予)\s*([一-鿿]{2,4})/g;

type BoundPole = "lower" | "upper";

function comparatorsForNumber(text: string, numText: string): BoundPole[] {
  if (!numText) return [];
  const lowerText = text.toLowerCase();
  const needle = numText.toLowerCase();
  const poles: BoundPole[] = [];
  let from = 0;
  while (from <= lowerText.length - needle.length) {
    const idx = lowerText.indexOf(needle, from);
    if (idx < 0) break;
    from = idx + Math.max(1, needle.length);
    const before = text.slice(Math.max(0, idx - 32), idx);
    const after = text.slice(idx + numText.length, idx + numText.length + 14);

    const isLower =
      /\b(?:at\s+least|no\s+less\s+than|not\s+less\s+than|minimum\s+of)\s*$/i.test(before) ||
      /(?<!\bno\s)(?<!\bnot\s)\b(?:more\s+than|greater\s+than|exceeding|over)\s*$/i.test(before) ||
      /(?:>=|≥)\s*$/.test(before) ||
      /(?:不少于|不低于|至少)\s*$/.test(before) ||
      /(?<!不)(?:多于|超过|高于)\s*$/.test(before) ||
      /^\s*(?:个?(?:工作日|自然日|日|天|周|星期|个月|年|小时|%|万元|亿元|元))?\s*(?:以上|或以上)/.test(after);

    const isUpper =
      /\b(?:at\s+most|no\s+more\s+than|not\s+more\s+than|up\s+to|maximum\s+of|capped\s+at|not\s+exceed(?:ing)?)\s*$/i.test(
        before,
      ) ||
      /(?<!\bno\s)(?<!\bnot\s)\b(?:less\s+than|fewer\s+than|under)\s*$/i.test(before) ||
      /(?:<=|≤)\s*$/.test(before) ||
      /(?:不超过|不多于|不高于|至多|最多)\s*$/.test(before) ||
      /(?<!不)(?:少于|低于)\s*$/.test(before) ||
      /^\s*(?:个?(?:工作日|自然日|日|天|周|星期|个月|年|小时|%|万元|亿元|元))?\s*(?:以内|以下|为上限)/.test(after);

    if (isLower && !isUpper) poles.push("lower");
    else if (isUpper && !isLower) poles.push("upper");
  }
  return [...new Set(poles)];
}

type TimePole = "within" | "after";

function deadlinePoleAround(text: string, numText: string): TimePole | null {
  const idx = text.toLowerCase().indexOf(numText.toLowerCase());
  if (idx < 0) return null;
  const before = text.slice(Math.max(0, idx - 20), idx);
  const after = text.slice(idx + numText.length, idx + numText.length + 24);

  const isWithin =
    /\b(?:within|no\s+later\s+than|before)\s*$/i.test(before) ||
    /^\s*(?:个?(?:工作日|自然日|日|天|周|星期|个月|年|小时))?\s*(?:内|之内|以内)/.test(after);
  const isAfter =
    /\b(?:after|following|upon\s+expiration\s+of)\s*$/i.test(before) ||
    /^\s*(?:个?(?:工作日|自然日|日|天|周|星期|个月|年|小时))\s*(?:后|之后|以后|届满后)/.test(after);

  if (isWithin && !isAfter) return "within";
  if (isAfter && !isWithin) return "after";
  return null;
}

type TrendPole = "up" | "down";

function trendPoleAround(text: string, numText: string): TrendPole | null {
  const idx = text.toLowerCase().indexOf(numText.toLowerCase());
  if (idx < 0) return null;
  const window = text.slice(Math.max(0, idx - 28), idx + numText.length + 16);
  const up = /\b(?:increased?|grew|risen|rose|up)\b|增长|上升|提高|上调/i.test(window);
  const down = /\b(?:decreased?|fell|dropped|declined|reduced|down)\b|下降|减少|降低|下调/i.test(window);
  if (up && !down) return "up";
  if (down && !up) return "down";
  return null;
}

const PARTY_PAIRS: ReadonlyArray<{
  a: RegExp;
  b: RegExp;
  aName: string;
  bName: string;
  duty: RegExp;
}> = [
  {
    a: /甲方/,
    b: /乙方/,
    aName: "甲方",
    bName: "乙方",
    duty: /承担|支付|赔偿|负责|缴纳|退还|返还|提供担保/,
  },
  {
    a: /\b(?:buyer|purchaser|client|customer)\b/i,
    b: /\b(?:seller|vendor|supplier|contractor)\b/i,
    aName: "Buyer",
    bName: "Seller",
    duty: /\b(?:shall\s+pay|must\s+pay|bears?|indemnif(?:y|ies)|is\s+liable\s+for|is\s+responsible\s+for|reimburses?)\b/i,
  },
  {
    a: /\b(?:landlord|lessor)\b/i,
    b: /\b(?:tenant|lessee)\b/i,
    aName: "Landlord",
    bName: "Tenant",
    duty: /\b(?:shall\s+pay|must\s+pay|bears?|maintains?|repairs?|is\s+responsible\s+for)\b/i,
  },
];

/**
 * Return human-readable contradiction tokens when `claim` flips the polarity,
 * bound direction, deadline direction, trend direction, or sole obligated party
 * of `context`; empty array when consistent or indeterminate.
 */
export function polarityMismatch(claim: string, context: string): string[] {
  if (!claim.trim() || !context.trim()) return [];
  const normClaim = claim.normalize("NFKC");
  const normCtx = context.normalize("NFKC");
  const reasons: string[] = [];

  // 1. Direct lexical antonyms (refundable / revocable / transferable / exclusive)
  for (const pair of LEXICAL_ANTONYMS) {
    const claimNeg = pair.neg.test(normClaim);
    const claimPos = pair.pos.test(normClaim);
    const ctxNeg = pair.neg.test(normCtx);
    const ctxPos = pair.pos.test(normCtx);
    if (claimNeg && !claimPos && ctxPos && !ctxNeg) {
      reasons.push(pair.label);
    } else if (claimPos && !claimNeg && ctxNeg && !ctxPos) {
      reasons.push(pair.label);
    }
  }

  // 2. Modal prohibition vs permission on the SAME verb (unless conditional escape present)
  if (!CONDITIONAL_ESCAPE_EN.test(normCtx) && !CONDITIONAL_ESCAPE_EN.test(normClaim)) {
    const cProhibit = extractModalVerbsEn(normClaim, EN_PROHIBIT_VERB);
    const cPermit = extractModalVerbsEn(normClaim, EN_PERMIT_VERB);
    const pProhibit = extractModalVerbsEn(normCtx, EN_PROHIBIT_VERB);
    const pPermit = extractModalVerbsEn(normCtx, EN_PERMIT_VERB);
    for (const v of cProhibit) {
      if (pPermit.has(v) && !pProhibit.has(v)) reasons.push(`prohibited vs permitted (${v})`);
    }
    for (const v of cPermit) {
      if (pProhibit.has(v) && !pPermit.has(v)) reasons.push(`permitted vs prohibited (${v})`);
    }
  }

  if (!CONDITIONAL_ESCAPE_ZH.test(normCtx) && !CONDITIONAL_ESCAPE_ZH.test(normClaim)) {
    const cProhibitZh = extractModalVerbsZh(normClaim, ZH_PROHIBIT_VERB);
    const cPermitZh = extractModalVerbsZh(normClaim, ZH_PERMIT_VERB);
    const pProhibitZh = extractModalVerbsZh(normCtx, ZH_PROHIBIT_VERB);
    const pPermitZh = extractModalVerbsZh(normCtx, ZH_PERMIT_VERB);
    for (const v of cProhibitZh) {
      if (pPermitZh.has(v) && !pProhibitZh.has(v)) reasons.push(`不得${v} ↔ 可以${v}`);
    }
    for (const v of cPermitZh) {
      if (pProhibitZh.has(v) && !pPermitZh.has(v)) reasons.push(`可以${v} ↔ 不得${v}`);
    }
  }

  // 3. Shared-quantity bound / deadline / trend flips
  const claimQs = quantities(normClaim);
  const ctxQs = quantities(normCtx, { implicit: true });
  for (const cq of claimQs) {
    const matching = ctxQs.filter((pq) => statedIn(cq, [pq]));
    if (matching.length === 0) continue;

    const cBounds = comparatorsForNumber(normClaim, cq.text);
    if (cBounds.length === 1) {
      const cBound = cBounds[0]!;
      const pBounds = [...new Set(matching.flatMap((pq) => comparatorsForNumber(normCtx, pq.text)))];
      if (pBounds.length === 1 && pBounds[0] !== cBound) {
        reasons.push(`${cq.text} (${cBound === "lower" ? "≥ vs ≤" : "≤ vs ≥"})`);
      }
    }

    const cTime = deadlinePoleAround(normClaim, cq.text);
    if (cTime) {
      const pTimes = matching.map((pq) => deadlinePoleAround(normCtx, pq.text)).filter(Boolean);
      if (pTimes.length > 0 && pTimes.every((t) => t !== cTime)) {
        reasons.push(`${cq.text} (${cTime === "within" ? "within vs after" : "after vs within"})`);
      }
    }

    const cTrend = trendPoleAround(normClaim, cq.text);
    if (cTrend) {
      const pTrends = matching.map((pq) => trendPoleAround(normCtx, pq.text)).filter(Boolean);
      if (pTrends.length > 0 && pTrends.every((t) => t !== cTrend)) {
        reasons.push(`${cq.text} (${cTrend === "up" ? "increase vs decrease" : "decrease vs increase"})`);
      }
    }
  }

  // 4. Sole-party obligation swap (when context mentions ONLY one party and claim names ONLY the opposite party)
  for (const pair of PARTY_PAIRS) {
    if (!pair.duty.test(normClaim) || !pair.duty.test(normCtx)) continue;
    const cA = pair.a.test(normClaim);
    const cB = pair.b.test(normClaim);
    const pA = pair.a.test(normCtx);
    const pB = pair.b.test(normCtx);
    if (cA && !cB && pB && !pA) {
      // Ensure shared action token in ZH
      if (pair.aName === "甲方") {
        const duties = ["承担", "支付", "赔偿", "负责", "缴纳", "退还", "返还"];
        if (!duties.some((d) => normClaim.includes(d) && normCtx.includes(d))) continue;
      }
      reasons.push(`${pair.aName} ↔ ${pair.bName}`);
    } else if (cB && !cA && pA && !pB) {
      if (pair.aName === "甲方") {
        const duties = ["承担", "支付", "赔偿", "负责", "缴纳", "退还", "返还"];
        if (!duties.some((d) => normClaim.includes(d) && normCtx.includes(d))) continue;
      }
      reasons.push(`${pair.bName} ↔ ${pair.aName}`);
    }
  }

  return [...new Set(reasons)];
}
