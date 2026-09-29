/**
 * Does the assistant's search find the page, when asked in the reader's words?
 *
 * Each question is a query as a model would type it — a few keywords, in the
 * words a reader would use rather than the document's — and the wording the
 * answer rests on. The right pages are not written down by hand: they are the
 * pages whose text carries that wording, found here, so a question cannot
 * quietly point at the wrong page.
 *
 * Scored for the search as it was before 13.0 (exact substring, page order)
 * and as it is now (the same, then ranked terms when the phrase is nowhere).
 * A hit is the right page among the first three pages returned: past three, a
 * model is reading its way to the answer rather than being taken there.
 */
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { searchForAgent, searchInDocument } from "../src/document/search";
import { corpusFiles, loadDoc, OUT, type DumpDoc } from "./lib/corpus";
import { QUESTIONS, type Question } from "./questions";


const squash = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s\-­‐-—'"‘’“”]/g, "");

function pagesWith(doc: DumpDoc, answer: string): number[] {
  const needle = squash(answer);
  return doc.pages.filter((p) => squash(p.text).includes(needle)).map((p) => p.page);
}

function firstPages(hits: Array<{ page: number }>, n: number): number[] {
  const out: number[] = [];
  for (const h of hits) {
    if (!out.includes(h.page)) out.push(h.page);
    if (out.length >= n) break;
  }
  return out;
}

describe("search", () => {
  it("finds the page asked about in the reader's words", () => {
    const docs = new Map(corpusFiles().map((f) => {
      const d = loadDoc(f);
      return [d.id, d] as const;
    }));
    const rows: Array<{ q: Question; expected: number[]; before: number[]; after: number[] }> = [];
    for (const q of QUESTIONS) {
      const doc = docs.get(q.doc);
      if (!doc) continue; // a fetched document that was not fetched
      const expected = pagesWith(doc, q.answer);
      expect(expected, `"${q.answer}" must be on some page of ${q.doc}`).not.toHaveLength(0);
      const pages = doc.pages.map((p) => ({ page: p.page, text: p.text }));
      rows.push({
        q,
        expected,
        before: firstPages(searchInDocument(pages, q.query, 13), 3),
        after: firstPages(searchForAgent(pages, q.query, 13), 3),
      });
    }
    const hit = (got: number[], want: number[]) => got.some((p) => want.includes(p));
    const before = rows.filter((r) => hit(r.before, r.expected)).length;
    const after = rows.filter((r) => hit(r.after, r.expected)).length;
    // Stricter, because several documents here are three pages long and
    // "right page in the first three" is nearly free on them.
    const firstBefore = rows.filter((r) => hit(r.before.slice(0, 1), r.expected)).length;
    const firstAfter = rows.filter((r) => hit(r.after.slice(0, 1), r.expected)).length;
    const lines = [
      "| document | query | right page | before | after |",
      "|---|---|---|---|---|",
      ...rows.map(
        (r) =>
          `| ${r.q.doc} | ${r.q.query} | ${r.expected.join(",")} | ${r.before.join(",") || "—"}${hit(r.before, r.expected) ? " ✓" : ""} | ${r.after.join(",") || "—"}${hit(r.after, r.expected) ? " ✓" : ""} |`,
      ),
      `| **all** | ${rows.length} questions | | **${before}** | **${after}** |`,
      `| **first page right** | | | **${firstBefore}** | **${firstAfter}** |`,
    ];
    console.log(lines.join("\n"));
    writeFileSync(join(OUT, "search.json"), JSON.stringify({ questions: rows.length, before, after, firstBefore, firstAfter, rows }, null, 2));

    // Never worse on any single question than the search it replaces.
    for (const r of rows) {
      if (hit(r.before, r.expected)) expect(hit(r.after, r.expected), `${r.q.doc}: ${r.q.query}`).toBe(true);
    }
    expect(after / rows.length).toBeGreaterThanOrEqual(SEARCH_GATE);
  });
});

/** Right page in the first three, over the whole question set. */
export const SEARCH_GATE = 0.8;
