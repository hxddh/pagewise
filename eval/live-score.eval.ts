/**
 * Score recorded answers from real models: `npm run eval` after `npm run eval:live`.
 *
 * Every recording under `eval/out/live/` (local, ignored by git) and
 * `eval/baselines/` (committed, when someone chooses to publish one) is read
 * and scored with no model and no network:
 *
 *   cited      answers carrying at least one citation marker
 *   quoted     citations that carry a quote, and so can be checked
 *   located    quoted citations whose words are on the page they name —
 *              located here with `locateQuote` over the page's own runs, the
 *              same check the app runs, not read back from the UI
 *   unfound    quoted citations whose page has text and not these words
 *   right page answers that cite at least one page carrying the wording the
 *              answer rests on
 *
 * Nothing is gated here: a model's behaviour is what is being measured, not a
 * property of this repository. The numbers are for comparing prompt changes
 * and models against each other on the same questions.
 */
import { describe, it } from "vitest";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractCitations } from "../src/lib/citations";
import { locateQuote } from "../src/lib/quote-locate";
import { OUT, ROOT, corpusFiles, loadDoc, type DumpDoc } from "./lib/corpus";

interface Recording {
  doc: string;
  question: string;
  answerWording: string;
  model: string;
  answer: string;
  error: string | null;
  steps: number;
}

function recordings(): Array<{ file: string; recs: Recording[] }> {
  const dirs = [join(OUT, "live"), join(ROOT, "eval/baselines")];
  const out: Array<{ file: string; recs: Recording[] }> = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()) {
      const recs = readFileSync(join(dir, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Recording);
      out.push({ file: f, recs });
    }
  }
  return out;
}

const squash = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s\-­‐-—'"‘’“”]/g, "");

export interface Score {
  answers: number;
  errors: number;
  cited: number;
  citations: number;
  quoted: number;
  located: number;
  unfound: number;
  unreadable: number;
  outOfRange: number;
  rightPage: number;
  meanSteps: number;
}

export function score(recs: Recording[], docs: Map<string, DumpDoc>): Score {
  const s: Score = { answers: 0, errors: 0, cited: 0, citations: 0, quoted: 0, located: 0, unfound: 0, unreadable: 0, outOfRange: 0, rightPage: 0, meanSteps: 0 };
  let steps = 0;
  for (const r of recs) {
    const doc = docs.get(r.doc);
    if (!doc) continue;
    s.answers += 1;
    steps += r.steps;
    if (r.error) {
      s.errors += 1;
      continue;
    }
    const cites = extractCitations(r.answer);
    if (cites.length > 0) s.cited += 1;
    const right = doc.pages.filter((p) => squash(p.text).includes(squash(r.answerWording))).map((p) => p.page);
    if (cites.some((c) => c.pages.some((p) => right.includes(p)))) s.rightPage += 1;
    for (const c of cites) {
      s.citations += 1;
      if (c.pages.some((p) => p > doc.page_count)) {
        s.outOfRange += 1;
        continue;
      }
      if (!c.quote) continue;
      const outcomes = c.pages.map((p) => locateQuote(doc.pages[p - 1]?.items ?? [], c.quote!).status);
      if (outcomes.includes("uncheckable")) continue;
      s.quoted += 1;
      if (outcomes.includes("located")) s.located += 1;
      else if (outcomes.includes("unreadable")) s.unreadable += 1;
      else s.unfound += 1;
    }
  }
  s.meanSteps = s.answers ? steps / s.answers : 0;
  return s;
}

const pct = (a: number, b: number) => (b === 0 ? "—" : `${((100 * a) / b).toFixed(0)}%`);

describe("recorded answers from real models", () => {
  const found = recordings();
  it.skipIf(found.length === 0)("are scored", () => {
    const docs = new Map(corpusFiles().map((f) => {
      const d = loadDoc(f);
      return [d.id, d] as const;
    }));
    const rows = found.map(({ file, recs }) => ({ file, model: recs[0]?.model ?? "?", ...score(recs, docs) }));
    console.log(
      [
        "| recording | model | answers | cited | quoted | located | unfound | out of range | right page | steps |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
        ...rows.map(
          (r) =>
            `| ${r.file} | ${r.model} | ${r.answers}${r.errors ? ` (${r.errors} failed)` : ""} | ${pct(r.cited, r.answers - r.errors)} | ` +
            `${r.quoted}/${r.citations} | ${pct(r.located, r.quoted)} | ${r.unfound} | ${r.outOfRange} | ` +
            `${pct(r.rightPage, r.answers - r.errors)} | ${r.meanSteps.toFixed(1)} |`,
        ),
      ].join("\n"),
    );
    writeFileSync(join(OUT, "live-score.json"), JSON.stringify(rows, null, 2));
  });
});
