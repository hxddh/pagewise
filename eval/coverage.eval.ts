/**
 * When an answer read the wrong page, does "not read, but matches" point at
 * the right one? (15.0)
 *
 * The 36 evaluation questions, each answered — in this simulation — by
 * reading only the page the model's own search query ranked first. Where that
 * page is not the one with the answer, the suggestion is computed exactly as
 * the app computes it (`rankUnreadPages`, from the reader's question and the
 * pages read) and scored on whether the right page is among its three.
 *
 * Also reported: how many pages it suggests when the first page was right —
 * each of those is a line the reader did not need.
 */
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { rankPages } from "../src/lib/ranked-search";
import { rankUnreadPages } from "../src/lib/coverage";
import { corpusFiles, loadDoc, OUT } from "./lib/corpus";
import { QUESTIONS } from "./questions";

export const COVERAGE_GATE = 0.6;

const squash = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s\-­‐-—'"‘’“”]/g, "");

describe("pages an answer did not read", () => {
  it("points at the right page when the first read was wrong", () => {
    const docs = new Map(corpusFiles().map((f) => {
      const d = loadDoc(f);
      return [d.id, d] as const;
    }));
    let asked = 0;
    let wrongFirst = 0;
    let recovered = 0;
    let rightFirst = 0;
    let noiseLines = 0;
    const misses: string[] = [];
    for (const q of QUESTIONS) {
      const doc = docs.get(q.doc);
      if (!doc) continue;
      asked += 1;
      const pages = doc.pages.map((p) => ({ page: p.page, text: p.text }));
      const right = doc.pages.filter((p) => squash(p.text).includes(squash(q.answer))).map((p) => p.page);
      const read = rankPages(pages, q.query, 1).map((h) => h.page);
      const hint = rankUnreadPages(pages, q.question, read);
      if (right.some((p) => read.includes(p))) {
        rightFirst += 1;
        noiseLines += hint.length;
        continue;
      }
      wrongFirst += 1;
      if (right.some((p) => hint.includes(p))) recovered += 1;
      else misses.push(`${q.doc}: ${q.question} — right ${right.join(",")}, suggested ${hint.join(",") || "nothing"}`);
    }
    console.log(
      [
        `| questions | ${asked} |`,
        `| first page read was wrong | ${wrongFirst} |`,
        `| right page among the suggestions | ${recovered} of ${wrongFirst} |`,
        `| pages suggested when the first page was right (per question) | ${(noiseLines / Math.max(1, rightFirst)).toFixed(2)} |`,
      ].join("\n"),
    );
    for (const m of misses) console.log(`  MISSED ${m}`);
    writeFileSync(join(OUT, "coverage.json"), JSON.stringify({ asked, wrongFirst, recovered, rightFirst, noiseLines, misses }, null, 2));
    expect(wrongFirst).toBeGreaterThan(3);
    expect(recovered / wrongFirst).toBeGreaterThanOrEqual(COVERAGE_GATE);
  });
});
