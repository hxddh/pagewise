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
 *              answer rests on — every wording, when it rests on several
 *              (24.0); of the answers that have a right page, so "none"
 *              questions are left out of it
 *
 * Plus the sentence table (20.0): every sentence of every recorded answer,
 * through the same split and the same state rule the app uses
 * (`answer-sentences.ts`), so what the line under an answer would count is
 * measured here rather than asserted in copy:
 *
 *   sentences  the denominator the reader sees
 *   marked     sentences carrying at least one marker
 *   verified   marked sentences whose quoted markers are all located
 *   unchecked  sentences with no marker at all
 *   numbers    of those, the ones whose numbers are stated in the text the
 *              answer's located citations rest on — the local evidence a
 *              sentence with no citation can still be assigned
 *
 * Plus the table per kind of question (24.0; `questions.ts` names the kinds),
 * printed for every recording file:
 *
 *   located    quoted citations whose words are on the page they name, as above
 *   right page answers whose citations cover every page the answer rests on:
 *              for each wording in `answerWordings`, at least one page that
 *              carries it is cited. One wording for a lookup, so the same as
 *              the column above; a cross-page answer needs all of its pages.
 *              Not scored on "none" questions, which have no right page.
 *   facts      the mean, over answers to questions with `facts`, of the share
 *              of those facts the answer states (an array is alternatives;
 *              matched under `squashFact`, so "36 个月" states "36个月")
 *   says no    "none" questions only: answers that say the document does not
 *              contain the answer, in English or Chinese (`SAYS_NOT_FOUND`)
 *   refused    "none" questions only: the correct refusal — says no AND
 *              carries no located citation. A located citation means the
 *              answer presented a passage of the document as its answer, and
 *              on a question the document does not answer that passage cannot
 *              be one; a refusal that also cites nearby context is counted
 *              under "says no" but not here, so the gap between the two
 *              columns is that behaviour, visible rather than argued about
 *   fabricated quoted citations whose words are on no page of the document at
 *              all — not a wrong page, an invented quote. Of quoted
 *              citations, every kind; a quote too short to check is excluded,
 *              as everywhere else here
 *   tools      mean tool calls per answer, from the per-step names `run.mjs`
 *              records (recordings made before 24.0 have none: "—")
 *
 * Nothing is gated here: a model's behaviour is what is being measured, not a
 * property of this repository. The numbers are for comparing prompt changes
 * and models against each other on the same questions. A recording made with
 * `--repeat=N` counts every run as an answer: the shares are over samples.
 */
import { describe, it } from "vitest";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractCitations, type Citation } from "../src/lib/citations";
import { locateQuote } from "../src/lib/quote-locate";
import { passageAround } from "../src/lib/passage";
import { citationLevel } from "../src/lib/trust-level";
import {
  answerSentences,
  numbersInEvidence,
  sentenceState,
} from "../src/lib/answer-sentences";
import type { CitationStatus } from "../src/lib/citation-check";
import { OUT, ROOT, corpusFiles, loadDoc, type DumpDoc } from "./lib/corpus";
import { QUESTIONS, squashFact, type Fact, type QuestionKind } from "./questions";

interface Recording {
  /** Recorded since 24.0; older recordings are single lookups by `question`. */
  id?: string;
  kind?: QuestionKind;
  run?: number;
  doc: string;
  question: string;
  answerWording: string | null;
  answerWordings?: string[];
  facts?: Fact[];
  model: string;
  answer: string;
  error: string | null;
  steps: number;
  /** Tool names called at each step (24.0). */
  toolCalls?: string[][];
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
  /** Answers with a right page to cite: not failed, not a "none" question (24.0). */
  paged: number;
  rightPage: number;
  meanSteps: number;
  sentences: number;
  marked: number;
  verified: number;
  unchecked: number;
  /** Of `unchecked`: sentences whose numbers the answer's cited text states. */
  numbers: number;
}

/** What the local check would say about one citation, from the corpus dump alone. */
function statusOf(c: Citation, doc: DumpDoc): CitationStatus {
  if (c.pages.some((p) => p > doc.page_count)) return "outOfRange";
  if (!c.quote) return "unchecked";
  const outcomes = c.pages.map((p) => locateQuote(doc.pages[p - 1]?.items ?? [], c.quote!));
  if (outcomes.some((o) => o.status === "located")) return "located";
  if (outcomes.some((o) => o.status === "unreadable")) return "unreadable";
  if (outcomes.every((o) => o.status === "uncheckable")) return "tooShort";
  return "unlocated";
}

/**
 * One recording's sentences through the app's own table: the split
 * (`answerSentences`), the state rule (`sentenceState`) and the local-evidence
 * rule (`numbersInEvidence`) are the same functions the line under an answer
 * reads, so this column measures the product rather than a copy of it.
 */
function sentenceScore(answer: string, doc: DumpDoc): Pick<Score, "sentences" | "marked" | "verified" | "unchecked" | "numbers"> {
  const evidence: string[] = [];
  for (const c of extractCitations(answer)) {
    if (statusOf(c, doc) !== "located") continue;
    for (const p of c.pages) {
      const items = doc.pages[p - 1]?.items ?? [];
      const found = locateQuote(items, c.quote!);
      if (found.status === "located") evidence.push(passageAround(items, found.rects));
    }
    evidence.push(c.quote!);
  }
  const out = { sentences: 0, marked: 0, verified: 0, unchecked: 0, numbers: 0 };
  for (const sentence of answerSentences(answer)) {
    out.sentences += 1;
    if (sentence.citations.length === 0) {
      out.unchecked += 1;
      if (numbersInEvidence(sentence.text, evidence.join("\n"))) out.numbers += 1;
      continue;
    }
    out.marked += 1;
    if (sentenceState(sentence.citations.map((c) => citationLevel(statusOf(c, doc)))) === "verified") {
      out.verified += 1;
    }
  }
  return out;
}

export function score(recs: Recording[], docs: Map<string, DumpDoc>): Score {
  const s: Score = { answers: 0, errors: 0, cited: 0, citations: 0, quoted: 0, located: 0, unfound: 0, unreadable: 0, outOfRange: 0, paged: 0, rightPage: 0, meanSteps: 0, sentences: 0, marked: 0, verified: 0, unchecked: 0, numbers: 0 };
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
    // Graded only where there is a right page (24.0): a "none" question has
    // none, and counting it as a miss would sink the column as the set grew.
    const { wordings } = asked(r);
    if (wordings.length > 0) {
      s.paged += 1;
      if (coversWordings(cites, wordings, doc)) s.rightPage += 1;
    }
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
    const sentences = sentenceScore(r.answer, doc);
    for (const key of ["sentences", "marked", "verified", "unchecked", "numbers"] as const) {
      s[key] += sentences[key];
    }
  }
  s.meanSteps = s.answers ? steps / s.answers : 0;
  return s;
}

const pct = (a: number, b: number) => (b === 0 ? "—" : `${((100 * a) / b).toFixed(0)}%`);

// ---- per kind (24.0) ----------------------------------------------------------

/**
 * An answer saying the document does not contain what was asked. English: a
 * negation followed, within the clause, by a verb of saying or containing
 * ("does not mention", "no information … provided", "isn't specified"), or
 * the fixed phrases. Chinese: 没有/未/并未/无 followed closely by 提及/说明/
 * 规定/找到…, or "文档中没有". Read only on "none" questions, where it is the
 * expected answer; on others it would also match a hedge.
 */
export const SAYS_NOT_FOUND = [
  /(?:\bnot\b|\bno\b|\bnever\b|n['’]t\b)[^.!?\n]{0,80}?\b(?:mention|state|specif|say|said|contain|provide|include|found|find|appear|discuss|address|cover|list|give|given|describe|name|indicate|information|detail|disclose|record)/i,
  /\b(?:unable to (?:find|locate)|there is nothing|nowhere in the (?:document|text)|outside (?:the scope of )?(?:the|this) document)\b/i,
  /(?:没有|未|并未|不曾|无|找不到|未能)[^。！？\n]{0,24}?(?:提及|提到|说明|规定|写明|载明|涉及|找到|包含|记载|约定|列出|给出|列明|显示|信息|相关内容|有关内容)/,
  /(?:文档|文件|合同|本文|论文|资料)(?:中|里|内)?(?:并)?(?:没有|未|无)/,
];

export const saysNotFound = (answer: string) => SAYS_NOT_FOUND.some((re) => re.test(answer));

export interface KindScore {
  kind: QuestionKind;
  answers: number;
  errors: number;
  quoted: number;
  located: number;
  /** Answers graded for right page: not "none", not failed, with wordings. */
  paged: number;
  rightPage: number;
  /** Answers to questions with facts, and the sum of their fact shares. */
  withFacts: number;
  factShare: number;
  saysNo: number;
  refused: number;
  fabricated: number;
  /** Answers with tool names recorded, and their total tool calls. */
  withTools: number;
  toolCalls: number;
}

const QUESTION_BY_ID = new Map(QUESTIONS.map((q) => [q.id, q]));

/** What a recording was asked with: its own fields, else the question set's, else a lookup. */
function asked(r: Recording): { kind: QuestionKind; wordings: string[]; facts: Fact[] } {
  const q = r.id ? QUESTION_BY_ID.get(r.id) : undefined;
  return {
    kind: r.kind ?? q?.kind ?? "lookup",
    wordings: r.answerWordings ?? (r.answerWording ? [r.answerWording] : []),
    facts: r.facts ?? q?.facts ?? [],
  };
}

/**
 * Whether the citations name, for every wording, a page that carries it. One
 * wording — a lookup — is the rule this file has always had; several means a
 * cross-page answer must cite each page it rests on (24.0).
 */
function coversWordings(cites: Citation[], wordings: string[], doc: DumpDoc): boolean {
  const cited = new Set(cites.flatMap((c) => c.pages));
  return wordings.every((w) => doc.pages.some((p) => cited.has(p.page) && squash(p.text).includes(squash(w))));
}

/** Whether a quote is located on any page of the document; null when it is too short to check anywhere. */
function onAnyPage(quote: string, doc: DumpDoc): boolean | null {
  let checkable = false;
  for (const page of doc.pages) {
    const status = locateQuote(page.items ?? [], quote).status;
    if (status === "located") return true;
    if (status !== "uncheckable") checkable = true;
  }
  return checkable ? false : null;
}

export function scoreByKind(recs: Recording[], docs: Map<string, DumpDoc>): KindScore[] {
  const out = new Map<QuestionKind, KindScore>();
  for (const r of recs) {
    const doc = docs.get(r.doc);
    if (!doc) continue;
    const { kind, wordings, facts } = asked(r);
    const s =
      out.get(kind) ??
      { kind, answers: 0, errors: 0, quoted: 0, located: 0, paged: 0, rightPage: 0, withFacts: 0, factShare: 0, saysNo: 0, refused: 0, fabricated: 0, withTools: 0, toolCalls: 0 };
    out.set(kind, s);
    s.answers += 1;
    if (r.toolCalls) {
      s.withTools += 1;
      s.toolCalls += r.toolCalls.reduce((n, step) => n + step.length, 0);
    }
    if (r.error) {
      s.errors += 1;
      continue;
    }
    const cites = extractCitations(r.answer);
    let locatedHere = 0;
    for (const c of cites) {
      if (!c.quote || c.pages.some((p) => p > doc.page_count)) continue;
      const status = statusOf(c, doc);
      if (status === "tooShort") continue;
      s.quoted += 1;
      if (status === "located") {
        s.located += 1;
        locatedHere += 1;
      }
      if (onAnyPage(c.quote, doc) === false) s.fabricated += 1;
    }
    if (kind === "none") {
      const no = saysNotFound(r.answer);
      if (no) s.saysNo += 1;
      if (no && locatedHere === 0) s.refused += 1;
    } else if (wordings.length > 0) {
      s.paged += 1;
      if (coversWordings(cites, wordings, doc)) s.rightPage += 1;
    }
    if (facts.length > 0) {
      const said = squashFact(r.answer);
      const stated = facts.filter((f) => (Array.isArray(f) ? f : [f]).some((alt) => said.includes(squashFact(alt))));
      s.withFacts += 1;
      s.factShare += stated.length / facts.length;
    }
  }
  const order: QuestionKind[] = ["lookup", "list", "crossPage", "none", "scanned"];
  return [...out.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

function kindTable(file: string, kinds: KindScore[]): string {
  const total = kinds.reduce(
    (t, k) => {
      for (const key of Object.keys(t) as Array<keyof typeof t>) t[key] += k[key];
      return t;
    },
    { answers: 0, errors: 0, quoted: 0, located: 0, paged: 0, rightPage: 0, withFacts: 0, factShare: 0, saysNo: 0, refused: 0, fabricated: 0, withTools: 0, toolCalls: 0 },
  );
  const row = (label: string, k: Omit<KindScore, "kind">, isNone: boolean) =>
    `| ${label} | ${k.answers}${k.errors ? ` (${k.errors} failed)` : ""} | ${pct(k.located, k.quoted)} (${k.located}/${k.quoted}) | ` +
    `${isNone ? "—" : pct(k.rightPage, k.paged)} | ${k.withFacts ? `${((100 * k.factShare) / k.withFacts).toFixed(0)}%` : "—"} | ` +
    `${isNone ? pct(k.saysNo, k.answers - k.errors) : "—"} | ${isNone ? pct(k.refused, k.answers - k.errors) : "—"} | ` +
    `${pct(k.fabricated, k.quoted)} (${k.fabricated}) | ${k.withTools ? (k.toolCalls / k.withTools).toFixed(1) : "—"} |`;
  return [
    `**${file}**`,
    "",
    "| kind | answers | located | right page | facts | says no | refused | fabricated | tools |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...kinds.map((k) => row(k.kind, k, k.kind === "none")),
    row("**all**", total, false),
  ].join("\n");
}

describe("recorded answers from real models", () => {
  const found = recordings();
  it.skipIf(found.length === 0)("are scored", () => {
    const docs = new Map(corpusFiles().map((f) => {
      const d = loadDoc(f);
      return [d.id, d] as const;
    }));
    const rows = found.map(({ file, recs }) => ({ file, model: recs[0]?.model ?? "?", ...score(recs, docs) }));
    const overall = [
      "| recording | model | answers | cited | quoted | located | unfound | out of range | right page | steps | sentences | marked | verified | unchecked (of them: numbers) |",
      "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
      ...rows.map(
        (r) =>
          `| ${r.file} | ${r.model} | ${r.answers}${r.errors ? ` (${r.errors} failed)` : ""} | ${pct(r.cited, r.answers - r.errors)} | ` +
          `${r.quoted}/${r.citations} | ${pct(r.located, r.quoted)} | ${r.unfound} | ${r.outOfRange} | ` +
          `${pct(r.rightPage, r.paged)} | ${r.meanSteps.toFixed(1)} | ${r.sentences} | ${r.marked} | ` +
          `${pct(r.verified, r.marked)} | ${r.unchecked} (${r.numbers}) |`,
      ),
    ].join("\n");
    // Per kind, per recording file (24.0).
    const byKind = found.map(({ file, recs }) => ({ file, kinds: scoreByKind(recs, docs) }));
    const perKind = byKind.map(({ file, kinds }) => kindTable(file, kinds)).join("\n\n");
    console.log(`${overall}\n\n${perKind}`);
    // Also as a file (24.0): vitest swallows a passing test's console unless
    // run with --disableConsoleIntercept, and the live-eval workflow uploads
    // this as the readable half of its artifact.
    writeFileSync(join(OUT, "live-score.md"), `${overall}\n\n${perKind}\n`);
    writeFileSync(join(OUT, "live-score.json"), JSON.stringify(rows.map((r, i) => ({ ...r, byKind: byKind[i]!.kinds })), null, 2));
  });
});
