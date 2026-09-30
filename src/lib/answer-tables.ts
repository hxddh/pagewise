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
import { cachedCitationCheck, withClaim, type CitationStatus } from "./citation-check";
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
  /** "2 of 3 found". */
  found: (located: number, total: number) => string;
  none: string;
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function pagesOf(c: Pick<Citation, "pages">): string {
  return c.pages.length > 1 ? `p. ${c.pages[0]}–${c.pages[c.pages.length - 1]}` : `p. ${c.pages[0]}`;
}

/**
 * The answer's tables as CSV — each with its headers plus two columns: the
 * pages each row cites with what the check found there, and how many of its
 * quotes were found. Tables are separated by a blank line. A byte-order mark
 * leads, so spreadsheet programs read Chinese as Chinese.
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
      const sources = citations.map((c) => `${pagesOf(c)} ${labels.status[statusOf(c)]}`);
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
export function claimBefore(markdown: string, index: number): string {
  const inRow = rowAt(markdown, index);
  if (!inRow) return claimSpanBefore(markdown, index);
  // Earlier markers in the row go first, so a pipe inside one of their quotes
  // cannot be mistaken for the cell's start.
  const line = markdown.slice(inRow.row.start, index).replace(citationRe(), "");
  return plain(line.slice(line.lastIndexOf("|") + 1));
}
