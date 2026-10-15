/**
 * An answer's sentences, and the state of the evidence behind each (20.0).
 *
 * The checks the app runs are local, deterministic and free: whether the
 * quoted words are on the page a marker names (`citation-check.ts` +
 * `quote-locate.ts`), and whether the numbers a sentence states are in the
 * passage around the quote (`quantities.ts`). Until 20.0 they ran on the
 * citations, and the line under an answer counted citations — so a
 * two-sentence answer with one verified citation read as though the whole
 * answer had been checked, and a sentence with no marker was counted nowhere
 * and shown nothing.
 *
 * This is the sentence table: the answer split into the units a reader reads —
 * prose sentences, list items, one Markdown table row — each with the markers
 * that stand behind it and the state they put it in. Five states, one per
 * sentence:
 *
 *   - `verified`  — a quoted marker located on its page, and no marker of the
 *                   sentence read at a worse level. "Verified" keeps meaning
 *                   exactly what it meant per citation: the words are on the
 *                   page and the sentence's numbers are in the passage;
 *   - `check`     — a quoted marker found with a number the passage does not
 *                   state, or one the app could not read (a scan OCR may have
 *                   misread, a failed read): look at the page;
 *   - `notFound`  — a quoted marker the named page does not carry, or a page
 *                   past the end;
 *   - `noQuote`   — markers, but none carrying a quote to check: a page to
 *                   turn to, or a quote too short to mean anything
 *                   (`MIN_QUOTE_CHARS`);
 *   - `unchecked` — no marker at all: nothing says where this sentence came
 *                   from. The word for the silence, and the most valuable of
 *                   the five — it is the one no other count could show.
 *
 * Plus `pending`, while a marker's check is still running: the chips are
 * already checking as the stream closes each marker, and this is what lets the
 * line under a live answer show the counts land rather than appear at the end.
 *
 * The worst level among a sentence's markers wins, so the line under an answer
 * can never call a sentence verified while one of its chips shows a failure,
 * and a table row — one sentence here — is only as verified as its
 * least-verified cell (the rule `verifiedSentences` has applied to rows since
 * 15.0, now a consequence of the sentence rather than a special case).
 *
 * A SENTENCE WITH NO MARKER IS NEVER VERIFIED. What the local checks can still
 * say about it is whether the numbers it states are stated in the passages the
 * answer's own located citations rest on — the only text the answer has
 * locally — and that is recorded as `numbersInEvidence`. It is evidence about
 * the numbers, not a check of the sentence: the sentence reads `unchecked`
 * either way, and no verification is invented for it.
 *
 * The markers are the answer's own (`citations.ts`), and what one stands
 * behind is decided by `claimBefore` — the same words the chip, the tally, the
 * CSV and the model feedback read (15.0). The split never cuts inside a
 * marker, a code span, a math span or a table row.
 */
import { answerTables, claimBefore, rowClaim, type AnswerRow, type AnswerTable } from "./answer-tables";
import { cachedCitationCheck, withClaim, type CitationStatus } from "./citation-check";
import { citationRe, extractCitations, sentenceBefore, sentenceEndRe, type Citation } from "./citations";
import { cachedReview } from "./claim-review";
import { markdownToPlainText } from "./markdown-text";
import { quantities, statedIn, type Quantity } from "./quantities";
import { citationLevel, type TrustLevel } from "./trust-level";

/** The state of one sentence. `pending` is the transient sixth: its check is running. */
export type SentenceState = "verified" | "check" | "notFound" | "noQuote" | "unchecked" | "pending";

/** The five settled states, in the order the line under an answer shows them. */
export const SENTENCE_STATES: readonly SentenceState[] = [
  "verified",
  "check",
  "notFound",
  "noQuote",
  "unchecked",
];

/** What put a sentence in its state: a citation's status, or no marker at all. */
export type SentenceReason = CitationStatus | "pending" | "noMarker";

export interface AnswerSentence {
  /** The sentence's words: Markdown decoration and citation markers removed. */
  text: string;
  /** The sentence's offsets in the answer's Markdown. */
  start: number;
  end: number;
  /** The markers that stand behind this sentence, in the order they appear. */
  citations: Citation[];
  /** The table row this sentence is, when it is one — in a table, the row is the claim. */
  row?: { table: AnswerTable; row: AnswerRow };
}

export interface SentenceRow {
  sentence: AnswerSentence;
  state: SentenceState;
  /** The marker status that decided the state; `noMarker` when the sentence has none. */
  reason: SentenceReason;
  /**
   * For a sentence with no marker: whether every number it states is stated in
   * the text the answer's located citations rest on. Always false otherwise.
   */
  numbersInEvidence: boolean;
}

interface Line {
  start: number;
  end: number;
}

function linesOf(markdown: string): Line[] {
  const out: Line[] = [];
  let offset = 0;
  for (const text of markdown.split("\n")) {
    out.push({ start: offset, end: offset + text.length });
    offset += text.length + 1;
  }
  return out;
}

/** One span of the answer that becomes at most one sentence. */
interface Unit {
  start: number;
  end: number;
  row?: { table: AnswerTable; row: AnswerRow };
}

/**
 * The spans of one line that must not be split: citation markers, inline code
 * spans and inline math. A quote can carry a full stop of its own, and a code
 * span is one token however it is punctuated.
 *
 * Inline math is `$x$`, not `$ 5` or `5 $`: a currency amount would otherwise
 * pair with the next one and swallow the sentences between them.
 */
function protectedSpans(markdown: string, line: Line): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = line.start;
  while (i < line.end) {
    const ch = markdown[i]!;
    if (ch === "〔" || ch === "`" || ch === "$") {
      const close = ch === "〔" ? "〕" : ch;
      const at = markdown.indexOf(close, i + 1);
      const math = ch !== "$" || (at > i + 1 && !/\s/.test(markdown[i + 1]!) && !/\s/.test(markdown[at - 1]!));
      if (at >= 0 && at < line.end && math) {
        out.push([i, at + 1]);
        i = at + 1;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

/** The sentences of one line of prose, split at the same ends `citations.ts` uses. */
function proseUnits(markdown: string, line: Line): Unit[] {
  const protectedAt = protectedSpans(markdown, line);
  const inProtected = (at: number) => protectedAt.some(([s, e]) => at >= s && at < e);
  const out: Unit[] = [];
  const stops = sentenceEndRe();
  stops.lastIndex = line.start;
  let unitStart = line.start;
  let m: RegExpExecArray | null;
  while ((m = stops.exec(markdown)) !== null) {
    if (m.index >= line.end) break;
    if (inProtected(m.index)) continue;
    out.push({ start: unitStart, end: m.index + m[0].length });
    unitStart = m.index + m[0].length;
  }
  if (unitStart < line.end) out.push({ start: unitStart, end: line.end });
  return out;
}

/** The sentence's words: markers, decoration and list bullets gone. */
function words(raw: string): string {
  let text = markdownToPlainText(raw.replace(citationRe(), " "))
    .replace(/\s+/g, " ")
    // A marker taken out leaves the space that was before it: "30% , the
    // balance" is not how the sentence reads.
    .replace(/\s+([,.!?;:，。！？；：])/g, "$1")
    .trim();
  for (;;) {
    const next = text.replace(/^(?:\d+[.)、]|[-*+>])\s+/, "");
    if (next === text) return text;
    text = next;
  }
}

/**
 * Which unit a marker stands behind: the text just before it — `claimBefore`'s
 * rule, because a marker is evidence for the sentence that ends where it
 * starts. A marker with no text before it (a line that opens with one) stands
 * behind what follows it.
 */
function ownerOf(markdown: string, units: readonly Unit[], index: number): number {
  let at = index - 1;
  while (at >= 0 && /\s/.test(markdown[at]!)) at -= 1;
  if (at >= 0) {
    for (let i = 0; i < units.length; i += 1) {
      if (at >= units[i]!.start && at < units[i]!.end) return i;
    }
  }
  for (let i = 0; i < units.length; i += 1) {
    if (index >= units[i]!.start && index < units[i]!.end) return i;
  }
  return -1;
}

/**
 * The answer's sentences, in order. Code fences, math blocks and the header
 * and delimiter lines of a table are not sentences; a heading is a title, not
 * a claim, and is left out so a structured answer is not charged for its
 * structure. A table's body row is one sentence: in a table, the row is the
 * claim (`answer-tables.ts`).
 */
export function answerSentences(markdown: string): AnswerSentence[] {
  const tables = answerTables(markdown);
  const rowAtStart = new Map<number, { table: AnswerTable; row: AnswerRow }>();
  for (const table of tables) for (const row of table.rows) rowAtStart.set(row.start, { table, row });

  const units: Unit[] = [];
  let fence: string | null = null;
  let math = false;
  for (const line of linesOf(markdown)) {
    const trimmed = markdown.slice(line.start, line.end).trim();
    const fenceMark = /^(?:```+|~~~+)/.exec(trimmed)?.[0] ?? null;
    if (fence) {
      if (fenceMark && trimmed.startsWith(fence)) fence = null;
      continue;
    }
    if (fenceMark) {
      fence = fenceMark;
      continue;
    }
    if (math) {
      if (trimmed.includes("$$")) math = false;
      continue;
    }
    if (trimmed.startsWith("$$")) {
      if (!trimmed.slice(2).includes("$$")) math = true;
      continue;
    }
    const row = rowAtStart.get(line.start);
    if (row) {
      units.push({ start: line.start, end: line.end, row });
      continue;
    }
    // A table's header and delimiter lines carry no claim of their own.
    if (tables.some((t) => line.start >= t.start && line.start < t.end)) continue;
    // Blank lines are nothing, and a thematic break is not a sentence.
    if (!trimmed || /^#{1,6}(\s|$)/.test(trimmed) || /^(?:[-*_]\s*){3,}$/.test(trimmed)) continue;
    units.push(...proseUnits(markdown, line));
  }

  const citations = extractCitations(markdown);
  const owners = citations.map((c) => ownerOf(markdown, units, c.index));
  const sentences: AnswerSentence[] = [];
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i]!;
    const text = unit.row ? rowClaim(unit.row.table, unit.row.row) : words(markdown.slice(unit.start, unit.end));
    // A span with no words — a bare marker, a stray pipe — is not a sentence.
    if (!text) continue;
    const mine = citations.filter((_, at) => owners[at] === i);
    sentences.push({
      text,
      start: unit.start,
      end: unit.end,
      citations: mine,
      ...(unit.row ? { row: unit.row } : {}),
    });
  }
  return sentences;
}

/** How bad a level is for a sentence; the worst one wins. */
const SEVERITY: Record<TrustLevel, number> = { none: -1, verified: 0, check: 1, notFound: 2 };

/**
 * The state one sentence settles into, from the levels its markers were read
 * at and whether any of them is still being checked. The rule, in one place,
 * so a caller with its own checks (the evaluation) reaches the same states as
 * the app. Only for a sentence that has markers: a sentence with none is
 * `unchecked`, and is never verified.
 */
export function sentenceState(levels: readonly TrustLevel[], checking = false): SentenceState {
  if (levels.includes("notFound")) return "notFound";
  if (levels.includes("check")) return "check";
  if (levels.includes("verified")) return "verified";
  return checking ? "pending" : "noQuote";
}

/**
 * Whether every number a sentence states is stated in `evidence`.
 *
 * The quantity reader is deliberately exact and narrow (`quantities.ts`): it
 * only ever says "the text the answer cites states these numbers" — never that
 * the sentence is right, and never that a number is wrong. A sentence that
 * states no numbers, or an answer with no located citations, has nothing local
 * to say and is false here.
 */
export function numbersInEvidence(text: string, evidence: string): boolean {
  if (!evidence) return false;
  return numbersIn(quantities(evidence, { implicit: true }), text);
}

/** The same rule with the evidence already read, so one answer reads it once. */
function numbersIn(context: readonly Quantity[], text: string): boolean {
  const stated = quantities(text);
  return stated.length > 0 && stated.every((q) => statedIn(q, context));
}

/** The text the answer's own located citations rest on — its only local evidence. */
function citedPassages(path: string, sentences: readonly AnswerSentence[]): string {
  const parts: string[] = [];
  for (const sentence of sentences) {
    for (const c of sentence.citations) {
      const check = cachedCitationCheck(path, c);
      if (check?.status !== "located") continue;
      if (check.passage) parts.push(check.passage);
      if (c.quote) parts.push(c.quote);
    }
  }
  return parts.join("\n");
}

/**
 * Every sentence of the answer with the state of its evidence, read from the
 * checks the chips already ran (`citation-check.ts`) and the reader's model
 * reviews where they exist — a review can only lower a level, never raise one.
 */
export function sentenceStates(path: string, markdown: string): SentenceRow[] {
  const sentences = answerSentences(markdown);
  // Read once: the answer's own cited text is the evidence every sentence with
  // no marker is checked against.
  const evidence = quantities(citedPassages(path, sentences), { implicit: true });
  return sentences.map((sentence) => {
    if (sentence.citations.length === 0) {
      return {
        sentence,
        state: "unchecked",
        reason: "noMarker",
        numbersInEvidence: numbersIn(evidence, sentence.text),
      };
    }
    const levels: TrustLevel[] = [];
    let worst: { reason: SentenceReason; level: TrustLevel } | null = null;
    let checking = false;
    for (const c of sentence.citations) {
      const claim = claimBefore(markdown, c.index);
      const check = withClaim(cachedCitationCheck(path, c), claim, c.quote);
      const review = c.quote && claim ? cachedReview(path, claim, c.quote) : null;
      const reason: SentenceReason = check?.status ?? "pending";
      if (!check) checking = true;
      const level = citationLevel(reason, review?.verdict);
      levels.push(level);
      if (!worst || SEVERITY[level] > SEVERITY[worst.level]) worst = { reason, level };
    }
    return {
      sentence,
      state: sentenceState(levels, checking),
      reason: worst!.reason,
      numbersInEvidence: false,
    };
  });
}

export interface SentenceTally {
  /** Every sentence of the answer — the line's denominator (20.0). */
  total: number;
  verified: number;
  check: number;
  notFound: number;
  noQuote: number;
  unchecked: number;
  /** Sentences whose checks are still running. */
  pending: number;
  /** Of `unchecked`: those whose numbers the answer's own cited text states. */
  numbersInEvidence: number;
}

/** Count one answer's sentences by state. */
export function sentenceTally(rows: readonly SentenceRow[]): SentenceTally {
  const out: SentenceTally = {
    total: rows.length,
    verified: 0,
    check: 0,
    notFound: 0,
    noQuote: 0,
    unchecked: 0,
    pending: 0,
    numbersInEvidence: 0,
  };
  for (const row of rows) {
    out[row.state] += 1;
    if (row.state === "unchecked" && row.numbersInEvidence) out.numbersInEvidence += 1;
  }
  return out;
}

/** A sentence of an answer whose citation was found on its page. */
export interface VerifiedSentence {
  claim: string;
  page: number;
  quote: string;
}

/**
 * The sentences of an answer whose evidence holds, each with the page and the
 * words that confirm it. What "keep the verified sentences" writes to the
 * record: each becomes an entry whose evidence is already known to be on its
 * page, so it arrives in the record as *found on page N* rather than as a
 * claim to be checked.
 *
 * Read from the sentence table, so what is kept is exactly what the line under
 * the answer counted as verified (20.0): a sentence one of whose quoted
 * markers failed is not kept, and a table row is only as verified as its
 * least-verified cell.
 */
export function verifiedSentences(path: string, markdown: string): VerifiedSentence[] {
  const out: VerifiedSentence[] = [];
  const seen = new Set<string>();
  for (const row of sentenceStates(path, markdown)) {
    if (row.state !== "verified") continue;
    for (const c of row.sentence.citations) {
      if (!c.quote) continue;
      const check = withClaim(cachedCitationCheck(path, c), claimBefore(markdown, c.index), c.quote);
      if (check?.status !== "located" || !check.page) continue;
      const claim = row.sentence.row
        ? rowClaim(row.sentence.row.table, row.sentence.row.row)
        : sentenceBefore(markdown, c.index);
      if (!claim || seen.has(claim)) continue;
      seen.add(claim);
      out.push({ claim, page: check.page, quote: c.quote });
    }
  }
  return out;
}
