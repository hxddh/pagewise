/**
 * Does the number check flag wrong numbers, and only wrong numbers? (15.0)
 *
 * Every sentence of the corpus that states a quantity becomes a claim, cited
 * with a quote cut from that sentence — the way a model states a figure and
 * quotes the words that carry it. The quote is located among the page's runs
 * exactly as the app locates it, the passage around it is built by the app's
 * `passageAround`, and the claim is read against it by the app's
 * `unstatedQuantities`.
 *
 * Four kinds of claim:
 *
 *   - honest: the sentence as written — must never be flagged;
 *   - reworded: its Chinese numerals written as digits (三十六个月 → 36个月),
 *     its months as years where they divide (36 个月 → 3 年) — the same
 *     amount, so must never be flagged either;
 *   - wrong: one number changed — should be flagged. A changed number that
 *     happens to appear elsewhere in the same passage cannot be, by design:
 *     the check says "not in the passage", never "wrong".
 *
 * The false-alarm ceiling is the gate that matters: a flag on a correct
 * sentence is the check crying wolf, and a reader who learns to ignore it
 * will ignore the real one too.
 */
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { locateQuote } from "../src/lib/quote-locate";
import { passageAround } from "../src/lib/passage";
import { chineseNumeral, quantities, unstatedQuantities } from "../src/lib/quantities";
import { markdownToPlainText } from "../src/lib/markdown-text";
import { claimBefore } from "../src/lib/answer-tables";
import { extractCitations } from "../src/lib/citations";
import { corpusFiles, loadDoc, OUT, type DumpDoc } from "./lib/corpus";
import { rng } from "./lib/quotes";

export const NUMBER_GATES = { falseAlarms: 0.005, caught: 0.85 };

const CN = "零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟";

interface Claim {
  doc: string;
  page: number;
  sentence: string;
  quote: string;
}

/** Sentences stating a quantity, each with a quote cut from it that contains a number. */
function claimsOf(doc: DumpDoc): Claim[] {
  const next = rng(doc.id.length * 131 + doc.page_count);
  const out: Claim[] = [];
  for (const p of doc.pages) {
    const plain = markdownToPlainText(p.text.split("\n").filter((l) => !l.trim().startsWith("|")).join("\n"));
    for (const raw of plain.split(/(?<=[。；！？])|(?<=[.!?;])\s+|\n+/)) {
      // A clause number opening the line is a label, not a quantity.
      const sentence = raw.replace(/^\s*\d+(\.\d+)*\s+/, "").trim();
      if (sentence.length < 12 || sentence.length > 240) continue;
      const qs = quantities(sentence);
      if (qs.length === 0) continue;
      // Quote the words around the first quantity, as a model quoting its source would.
      const at = sentence.indexOf(qs[0]!.text);
      if (at < 0) continue;
      const start = Math.max(0, at - 6 - Math.floor(next() * 6));
      const quote = sentence.slice(start, Math.min(sentence.length, at + qs[0]!.text.length + 8)).trim();
      if (quote.length < 8) continue;
      out.push({ doc: doc.id, page: p.page, sentence, quote });
    }
  }
  return out;
}

/** The same amounts, differently written. Null when there is nothing to reword. */
function reword(s: string): string | null {
  const digits = s.replace(new RegExp(`([${CN}]+)(?=个月|日|天|年|小时|学时|元|%)`, "g"), (w) => {
    const v = chineseNumeral(w);
    return v === null ? w : String(v);
  });
  const years = digits.replace(/(\d+)\s*个月/g, (w, n: string) => (Number(n) % 12 === 0 && Number(n) > 0 ? `${Number(n) / 12}年` : w));
  return years !== s ? years : null;
}

/** One number changed, or null when the sentence has no Arabic or Chinese number to change. */
function falsify(s: string): string | null {
  if (/\d/.test(s)) return s.replace(/\d+/, (d) => String(Number(d) + 7));
  const m = new RegExp(`[${CN}]+(?=个月|日|天|年|小时|学时|元)`).exec(s);
  if (!m) return null;
  const v = chineseNumeral(m[0]);
  return v === null ? null : s.slice(0, m.index) + String(v + 7) + s.slice(m.index + m[0].length);
}

describe("numbers in a claim, read against the passage it cites", () => {
  it("flags changed numbers and never correct ones", () => {
    let located = 0;
    let honest = 0;
    let honestFlagged = 0;
    let reworded = 0;
    let rewordedFlagged = 0;
    let wrong = 0;
    let caught = 0;
    let wrongElsewhere = 0;
    let notQuantity = 0;
    const alarms: string[] = [];
    const misses: string[] = [];
    const rows: string[] = [];

    for (const file of corpusFiles()) {
      const doc = loadDoc(file);
      let docHonest = 0;
      let docWrong = 0;
      let docCaught = 0;
      for (const c of claimsOf(doc)) {
        const items = doc.pages.find((p) => p.page === c.page)?.items ?? [];
        const outcome = locateQuote(items, c.quote);
        if (outcome.status !== "located") continue;
        located += 1;
        const passage = `${passageAround(items, outcome.rects)}\n${c.quote}`;
        const flagged = (claim: string) => unstatedQuantities(claim, passage).length > 0;

        honest += 1;
        docHonest += 1;
        if (flagged(c.sentence)) {
          honestFlagged += 1;
          if (alarms.length < 15) alarms.push(`${c.doc} p${c.page}: ${c.sentence}`);
        }
        const r = reword(c.sentence);
        if (r) {
          reworded += 1;
          if (flagged(r)) {
            rewordedFlagged += 1;
            if (alarms.length < 15) alarms.push(`reworded ${c.doc} p${c.page}: ${r}`);
          }
        }
        const w = falsify(c.sentence);
        if (w) {
          // The changed value, if it happens to be in the passage anyway,
          // cannot be caught by a check that asks "is it in the passage".
          const changed = quantities(w).filter((q) => !quantities(c.sentence).some((o) => o.value === q.value && o.kind === q.kind));
          // The changed digits were a clause or section number, not a
          // quantity: the check does not read those, by design (16.0).
          if (changed.length === 0) {
            notQuantity += 1;
            continue;
          }
          if (unstatedQuantities(changed.map((q) => q.text).join(" "), passage).length === 0) {
            wrongElsewhere += 1;
            continue;
          }
          wrong += 1;
          docWrong += 1;
          if (flagged(w)) {
            caught += 1;
            docCaught += 1;
          } else if (misses.length < 10) misses.push(`${c.doc} p${c.page}: ${w}`);
        }
      }
      rows.push(`| ${doc.id} | ${docHonest} | ${docWrong} | ${docCaught} |`);
    }

    const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");
    console.log(
      [
        "| document | honest claims | changed numbers | caught |",
        "|---|---:|---:|---:|",
        ...rows,
        "",
        `| claims located | ${located} |`,
        `| honest, flagged | ${honestFlagged} of ${honest} (${pct(honestFlagged, honest)}) |`,
        `| reworded (numerals, units), flagged | ${rewordedFlagged} of ${reworded} (${pct(rewordedFlagged, reworded)}) |`,
        `| changed number, caught | ${caught} of ${wrong} (${pct(caught, wrong)}) |`,
        `| changed to a number the passage has anyway (not counted) | ${wrongElsewhere} |`,
        `| changed a clause or section number (not a quantity, not counted) | ${notQuantity} |`,
      ].join("\n"),
    );
    for (const a of alarms) console.log(`  ALARM ${a}`);
    for (const m of misses) console.log(`  MISSED ${m}`);
    writeFileSync(
      join(OUT, "numbers.json"),
      JSON.stringify({ located, honest, honestFlagged, reworded, rewordedFlagged, wrong, caught, wrongElsewhere, notQuantity, alarms, misses }, null, 2),
    );

    expect(honest).toBeGreaterThan(150);
    expect(reworded).toBeGreaterThan(30);
    expect((honestFlagged + rewordedFlagged) / (honest + reworded)).toBeLessThanOrEqual(NUMBER_GATES.falseAlarms);
    expect(caught / wrong).toBeGreaterThanOrEqual(NUMBER_GATES.caught);
  });
});

/**
 * How answers write the numbers a document states (16.0). Each case is an
 * answer, with markers, and the passage of each page it cites. The claim is
 * cut from the answer exactly as the app cuts it (`claimBefore`), so a claim
 * cut short by a decimal point, or run on across an earlier marker, fails
 * here as it would on screen. `wrong` changes one number of the answer:
 * that one must be caught.
 */
const VARIANTS: Array<{ name: string; answer: string; pages: Record<number, string>; wrong: string }> = [
  { name: "decimal amount", answer: '罚款为1,310,400.00元〔p2 "罚款"〕。', pages: { 2: "应支付罚款人民币1,310,400.00元。" }, wrong: '罚款为1,310,500.00元〔p2 "罚款"〕。' },
  { name: "decimal 万元", answer: '合同总价436.8万元〔p1 "总价"〕。', pages: { 1: "合同总价为人民币肆佰叁拾陆万捌仟元整。" }, wrong: '合同总价463.8万元〔p1 "总价"〕。' },
  { name: "decimal percent (en)", answer: 'Intro. The late fee is 3.5% of the overdue amount〔p4 "late fee"〕.', pages: { 4: "a late fee of 3.5% of the overdue amount applies" }, wrong: 'Intro. The late fee is 5.5% of the overdue amount〔p4 "late fee"〕.' },
  { name: "number opens the sentence", answer: '36 months is the warranty term〔p3 "warranty"〕.', pages: { 3: "The warranty term is thirty-six (36) months." }, wrong: '24 months is the warranty term〔p3 "warranty"〕.' },
  { name: "two markers, one sentence", answer: '定金为30%〔p2 "定金"〕，尾款为70%〔p3 "尾款"〕。', pages: { 2: "定金为合同价款的30%。", 3: "尾款为合同价款的70%，验收后支付。" }, wrong: '定金为30%〔p2 "定金"〕，尾款为60%〔p3 "尾款"〕。' },
  { name: "亿 and 万", answer: '注册资本一亿五千万元〔p1 "注册资本"〕。', pages: { 1: "注册资本：150,000,000元" }, wrong: '注册资本一亿三千万元〔p1 "注册资本"〕。' },
  { name: "1.5亿", answer: '注册资本1.5亿元〔p1 "注册资本"〕。', pages: { 1: "注册资本为人民币壹亿伍仟万元" }, wrong: '注册资本2.5亿元〔p1 "注册资本"〕。' },
  { name: "Chinese year", answer: '协议于二〇二五年生效〔p1 "生效"〕。', pages: { 1: "本协议自2025年1月1日起生效。" }, wrong: '协议于二〇二四年生效〔p1 "生效"〕。' },
  { name: "万分之 as percent", answer: '违约金为每日0.03%〔p5 "违约金"〕。', pages: { 5: "每逾期一日按逾期金额的万分之三支付违约金。" }, wrong: '违约金为每日0.3%〔p5 "违约金"〕。' },
  { name: "千分之 as percent", answer: 'The penalty is 0.3% per day〔p5 "penalty"〕.', pages: { 5: "按日千分之三计收滞纳金" }, wrong: 'The penalty is 0.03% per day〔p5 "penalty"〕.' },
  { name: "percent as a word", answer: 'A 30 percent deposit is due〔p2 "deposit"〕.', pages: { 2: "买方应支付30%的定金。" }, wrong: 'A 20 percent deposit is due〔p2 "deposit"〕.' },
  { name: "bare 万", answer: '罚款131.04万〔p2 "罚款"〕。', pages: { 2: "罚款金额1,310,400元。" }, wrong: '罚款113.04万〔p2 "罚款"〕。' },
  { name: "半年", answer: '保修期为6个月〔p3 "保修"〕。', pages: { 3: "保修期为半年，自验收之日起算。" }, wrong: '保修期为9个月〔p3 "保修"〕。' },
  { name: "一年半", answer: '租期18个月〔p1 "租期"〕。', pages: { 1: "租赁期限为一年半。" }, wrong: '租期12个月〔p1 "租期"〕。' },
  { name: "季度", answer: '每3个月结算一次〔p4 "结算"〕。', pages: { 4: "双方每季度结算一次。" }, wrong: '每2个月结算一次〔p4 "结算"〕。' },
  { name: "clause number", answer: '依据第9.2款，乙方承担30%〔p6 "乙方承担"〕。', pages: { 6: "乙方承担损失的30%。" }, wrong: '依据第9.2款，乙方承担40%〔p6 "乙方承担"〕。' },
  { name: "section number", answer: 'Under Section 12.3, notice is due within 30 days〔p7 "notice"〕.', pages: { 7: "notice must be given within thirty (30) days" }, wrong: 'Under Section 12.3, notice is due within 60 days〔p7 "notice"〕.' },
];

function flagsOf(answer: string, pages: Record<number, string>): string[] {
  return extractCitations(answer).flatMap((c) =>
    unstatedQuantities(claimBefore(answer, c.index), `${pages[c.pages[0]!] ?? ""}\n${c.quote ?? ""}`).map((q) => q.text),
  );
}

describe("numbers as answers write them (16.0)", () => {
  it("never flags a correct answer, and catches each changed number", () => {
    const alarms = VARIANTS.filter((v) => flagsOf(v.answer, v.pages).length > 0).map((v) => `${v.name}: ${flagsOf(v.answer, v.pages).join(", ")}`);
    const missed = VARIANTS.filter((v) => flagsOf(v.wrong, v.pages).length === 0).map((v) => v.name);
    console.log(`| variants | ${VARIANTS.length} | false alarms | ${alarms.length} | missed | ${missed.length} |`);
    for (const a of alarms) console.log(`  ALARM ${a}`);
    for (const m of missed) console.log(`  MISSED ${m}`);
    expect(alarms).toEqual([]);
    expect(missed).toEqual([]);
  });
});
