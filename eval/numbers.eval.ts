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
          if (changed.length > 0 && unstatedQuantities(changed.map((q) => q.text).join(" "), passage).length === 0) {
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
      ].join("\n"),
    );
    for (const a of alarms) console.log(`  ALARM ${a}`);
    for (const m of misses) console.log(`  MISSED ${m}`);
    writeFileSync(
      join(OUT, "numbers.json"),
      JSON.stringify({ located, honest, honestFlagged, reworded, rewordedFlagged, wrong, caught, wrongElsewhere, alarms, misses }, null, 2),
    );

    expect(honest).toBeGreaterThan(150);
    expect(reworded).toBeGreaterThan(30);
    expect((honestFlagged + rewordedFlagged) / (honest + reworded)).toBeLessThanOrEqual(NUMBER_GATES.falseAlarms);
    expect(caught / wrong).toBeGreaterThanOrEqual(NUMBER_GATES.caught);
  });
});
