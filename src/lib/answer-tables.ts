/**
 * Tables in an answer, and what their citations found (14.1).
 *
 * "List every payment term and penalty" is not a question with a paragraph
 * for an answer: it wants one row per item, and — for a reader who has to
 * rely on it — every value tied to the words it came from. The assistant is
 * asked to answer such requests as a Markdown table with a citation in each
 * cell (`agent.ts`). The citations are checked like any other; this module
 * reads the tables back out of the answer so that
 *
 *   - a kept row enters the record as that row ("Item: deposit · Amount: 30%"),
 *     not as whatever text happened to precede the marker;
 *   - a table leaves the app as CSV with its evidence beside it: which pages
 *     each row cites, and whether PageWise found the quoted words there.
 *
 * Plain GFM tables only: a header row, a delimiter row, body rows. A `|`
 * inside a citation marker's quote does not split a cell.
 */
import { citationRe, claimSpanBefore, extractCitations, stripCitations, type Citation } from "./citations";
import { citationLevel, type TrustLevel } from "./trust-level";
import { cachedCitationCheck, withClaim, type CitationStatus } from "./citation-check";
import { cachedReview, reviewBasis, type ReviewVerdict } from "./claim-review";
import { markdownToPlainText } from "./markdown-text";

export interface AnswerRow {
  /** Raw cell Markdown, markers included. */
  cells: string[];
  /** Offsets of the row's line in the answer. */
  start: number;
  end: number;
}

export interface AnswerTable {
  headers: string[];
  rows: AnswerRow[];
  start: number;
  end: number;
}

const DELIMITER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Split a row into cells on `|` outside citation markers and not escaped. */
function splitCells(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inMarker = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "〔") inMarker = true;
    if (ch === "〕") inMarker = false;
    if (ch === "\\" && line[i + 1] === "|") {
      cur += "|";
      i += 1;
      continue;
    }
    if (ch === "|" && !inMarker) {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  // A leading and trailing pipe leave empty edge cells.
  if (cells.length > 1 && cells[0]!.trim() === "") cells.shift();
  if (cells.length > 1 && cells[cells.length - 1]!.trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

export function answerTables(markdown: string): AnswerTable[] {
  const lines: Array<{ text: string; start: number; end: number }> = [];
  let offset = 0;
  for (const text of markdown.split("\n")) {
    lines.push({ text, start: offset, end: offset + text.length });
    offset += text.length + 1;
  }
  const tables: AnswerTable[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const head = lines[i]!;
    if (!head.text.includes("|") || !DELIMITER.test(lines[i + 1]!.text)) continue;
    const headers = splitCells(head.text).map(plain);
    const rows: AnswerRow[] = [];
    let j = i + 2;
    for (; j < lines.length; j++) {
      const line = lines[j]!;
      if (!line.text.includes("|") || !line.text.trim()) break;
      rows.push({ cells: splitCells(line.text), start: line.start, end: line.end });
    }
    tables.push({ headers, rows, start: head.start, end: rows.length ? rows[rows.length - 1]!.end : lines[i + 1]!.end });
    i = j - 1;
  }
  return tables;
}

/** A cell as the reader reads it: no markers, no Markdown. */
function plain(cell: string): string {
  return markdownToPlainText(stripCitations(cell)).replace(/\s+/g, " ").trim();
}

/** The table row a marker at `index` sits in, if any. */
export function rowAt(markdown: string, index: number): { table: AnswerTable; row: AnswerRow } | null {
  for (const table of answerTables(markdown)) {
    if (index < table.start || index > table.end) continue;
    const row = table.rows.find((r) => index >= r.start && index <= r.end);
    if (row) return { table, row };
  }
  return null;
}

/** A row as one line of claim: "Item: deposit · Amount: 30%". Empty cells and "—" are left out. */
export function rowClaim(table: AnswerTable, row: AnswerRow): string {
  return row.cells
    .map((cell, i) => [table.headers[i] ?? "", plain(cell)] as const)
    .filter(([, v]) => v && v !== "—" && v !== "-")
    .map(([h, v]) => (h ? `${h}: ${v}` : v))
    .join(" · ");
}

export interface CsvLabels {
  sources: string;
  checked: string;
  status: Record<CitationStatus | "pending", string>;
  /** The three words the chips use (16.0); the status follows in parentheses. */
  level: Record<Exclude<TrustLevel, "none">, string>;
  /**
   * The model's reading of a citation, where the reader asked for one (20.0).
   * Always the labelled words from `cite.review.*` — the same the chip shows —
   * so the export cannot file a model's verdict as a local check.
   */
  review: Record<ReviewVerdict, string>;
  /** "2 of 3 found". */
  found: (located: number, total: number) => string;
  none: string;
}

function csvField(raw: string): string {
  // A cell a spreadsheet would run as a formula is written as text (16.0).
  const value = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function pagesOf(c: Pick<Citation, "pages">): string {
  return c.pages.length > 1 ? `p. ${c.pages[0]}–${c.pages[c.pages.length - 1]}` : `p. ${c.pages[0]}`;
}

/**
 * The answer's tables as CSV — each with its headers plus two columns: the
 * pages each row cites with what the check found there, and how many of its
 * quotes were found. A citation the reader had their model review carries the
 * model's verdict beside the local check, labelled as the model's (20.0) —
 * the verdict is in-memory and per-citation, so an export without a review in
 * this session simply has nothing to add. Tables are separated by a blank
 * line. A byte-order mark leads, so spreadsheet programs read Chinese as
 * Chinese.
 */
export function tablesToCsv(path: string, markdown: string, labels: CsvLabels): string {
  const blocks: string[] = [];
  for (const table of answerTables(markdown)) {
    const lines = [[...table.headers, labels.sources, labels.checked].map(csvField).join(",")];
    for (const row of table.rows) {
      const citations = extractCitations(markdown).filter((c) => c.index >= row.start && c.index <= row.end);
      // Read against its cell, so a number the passage does not state shows here too.
      const statusOf = (c: Citation) =>
        withClaim(cachedCitationCheck(path, c), claimBefore(markdown, c.index), c.quote)?.status ?? "pending";
      const sources = citations.map((c) => {
        const review = c.quote
          ? cachedReview(path, claimBefore(markdown, c.index), c.quote, reviewBasis(cachedCitationCheck(path, c)))
          : null;
        // The chip's level, review included (v23): the CSV said "verified"
        // for a citation the model read as contradicted, and "not found" for
        // one it read as supported, where the chip said otherwise.
        const level = citationLevel(statusOf(c), review?.verdict);
        const said = labels.status[statusOf(c)];
        const verdict = review ? ` · ${labels.review[review.verdict]}` : "";
        return level === "none"
          ? `${pagesOf(c)} ${said}${verdict}`
          : `${pagesOf(c)} ${labels.level[level]} (${said})${verdict}`;
      });
      const quoted = citations.filter((c) => c.quote);
      const located = quoted.filter((c) => statusOf(c) === "located").length;
      const values = table.headers.map((_, i) => plain(row.cells[i] ?? ""));
      lines.push(
        [...values, sources.join("; "), quoted.length ? labels.found(located, quoted.length) : labels.none]
          .map(csvField)
          .join(","),
      );
    }
    blocks.push(lines.join("\r\n"));
  }
  return blocks.length ? `﻿${blocks.join("\r\n\r\n")}\r\n` : "";
}

/** Whether an answer has a table worth exporting. */
export function hasAnswerTable(markdown: string): boolean {
  return answerTables(markdown).some((t) => t.rows.length > 0);
}

/**
 * What a citation at `index` is evidence for: the text of its table cell up to
 * the marker, or — outside a table — the sentence before it. The one place this
 * is decided, so the chip, the tally, the record and the model feedback all
 * check the same words (15.0).
 */
interface CellSpan {
  raw: string;
  start: number;
  end: number;
  col: number;
}

function splitCellSpans(line: string, lineStart: number): CellSpan[] {
  const spans: Array<{ raw: string; start: number; end: number }> = [];
  let cur = "";
  let cellStart = 0;
  let inMarker = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === "〔") inMarker = true;
    if (ch === "〕") inMarker = false;
    if (ch === "\\" && line[i + 1] === "|") {
      cur += "\\|";
      i += 1;
      continue;
    }
    if (ch === "|" && !inMarker) {
      spans.push({ raw: cur, start: lineStart + cellStart, end: lineStart + i });
      cur = "";
      cellStart = i + 1;
      continue;
    }
    cur += ch;
  }
  spans.push({ raw: cur, start: lineStart + cellStart, end: lineStart + line.length });
  if (spans.length > 1 && spans[0]!.raw.trim() === "") spans.shift();
  if (spans.length > 1 && spans[spans.length - 1]!.raw.trim() === "") spans.pop();
  return spans.map((s, col) => ({ ...s, col }));
}

const INDEX_HEADER_RE = /^(?:#|no\.?|row|index|序号|编号)$/i;

/**
 * What a citation at `index` is evidence for:
 * - inside a table cell with its own text (before or after the marker): that
 *   cell's text (partitioned via `claimSpanBefore` if the cell holds multiple
 *   markers);
 * - inside a dedicated citation-only `Sources` cell (`plain(cell) === ""`):
 *   the uncited value cells of that row so numbers in sibling columns cannot
 *   bypass verification;
 * - outside a table: `claimSpanBefore`.
 */
export function claimBefore(markdown: string, index: number): string {
  const inRow = rowAt(markdown, index);
  if (!inRow) return claimSpanBefore(markdown, index);
  const rowText = markdown.slice(inRow.row.start, inRow.row.end);
  const spans = splitCellSpans(rowText, inRow.row.start);
  const cell = spans.find((s) => index >= s.start && index <= s.end);
  if (!cell) {
    const line = markdown.slice(inRow.row.start, index).replace(citationRe(), "");
    return plain(line.slice(line.lastIndexOf("|") + 1));
  }
  const cellCites = extractCitations(cell.raw);
  if (cellCites.length > 1) {
    return claimSpanBefore(cell.raw, index - cell.start);
  }
  const cellText = plain(cell.raw.replace(/\\\|/g, "|"));
  if (cellText && cellText !== "—" && cellText !== "-") {
    return cellText;
  }
  // Pure citation cell (e.g. `| Late fee | 25% | 〔p3 "Section 4"〕 |`):
  // verify the uncited value cells of the row against this citation.
  return spans
    .filter((s) => s.col !== cell.col && extractCitations(s.raw).length === 0)
    .filter((s) => !(s.col === 0 && INDEX_HEADER_RE.test((inRow.table.headers[0] ?? "").trim())))
    .map((s) => plain(s.raw.replace(/\\\|/g, "|")))
    .filter((v) => v && v !== "—" && v !== "-")
    .join(" · ");
}
