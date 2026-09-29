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

interface Question {
  doc: string;
  query: string;
  /** Wording that is on the page(s) that answer the question. */
  answer: string;
}

const QUESTIONS: Question[] = [
  // The Chinese contract, asked the way a reader asks.
  { doc: "contract-zh", query: "逾期付款 违约金", answer: "甲方逾期付款的" },
  { doc: "contract-zh", query: "延迟交货 违约责任", answer: "乙方逾期交货的" },
  { doc: "contract-zh", query: "保修期限", answer: "质保期为最终验收合格之日起三十六个月" },
  { doc: "contract-zh", query: "付款分几期", answer: "本合同价款分三期支付" },
  { doc: "contract-zh", query: "故障维修响应时间", answer: "响应时间不超过两小时" },
  { doc: "contract-zh", query: "患者隐私 数据", answer: "不得复制、存储、传输" },
  { doc: "contract-zh", query: "争议 起诉 法院", answer: "有管辖权的人民法院提起诉讼" },
  { doc: "contract-zh", query: "操作人员培训学时", answer: "不少于十六学时" },
  { doc: "contract-zh", query: "验收不合格 解除合同", answer: "第二次验收仍不合格的" },
  { doc: "contract-zh", query: "合同总金额", answer: "合同总价为人民币肆佰叁拾陆万捌仟元整" },
  { doc: "contract-zh", query: "不可抗力 通知期限", answer: "在事件发生后七日内书面通知对方" },
  { doc: "contract-zh", query: "开机率", answer: "设备年度开机率应不低于百分之九十五" },
  // The same contract set by the other typesetter: the ranking must not depend on layout.
  { doc: "contract-zh-rl", query: "逾期付款 违约金", answer: "甲方逾期付款的" },
  { doc: "contract-zh-rl", query: "保修期限", answer: "质保期为最终验收合格之日起三十六个月" },
  { doc: "contract-zh-rl", query: "争议 起诉 法院", answer: "有管辖权的人民法院提起诉讼" },
  // The paper.
  { doc: "paper-en", query: "memory overhead of the filter", answer: "Memory use is fixed" },
  { doc: "paper-en", query: "how the sampling rate adapts", answer: "is doubled (up to 1/8)" },
  { doc: "paper-en", query: "cases where admission control hurts", answer: "Two situations defeat the filter" },
  { doc: "paper-en", query: "workloads traces used", answer: "We use four traces" },
  { doc: "paper-en", query: "withdrawn result", answer: "has been withdrawn" },
  { doc: "paper-en", query: "throughput cost per request", answer: "per request on the test machine" },
  { doc: "paper-en", query: "main results comparison", answer: "Table 1 summarises the main result" },
  // The licences.
  { doc: "gpl-3.0", query: "patent grant from contributors", answer: "royalty-free patent license under the contributor" },
  { doc: "gpl-3.0", query: "warranty disclaimer", answer: "THERE IS NO WARRANTY FOR THE PROGRAM" },
  { doc: "gpl-3.0", query: "anti-circumvention laws DRM", answer: "Protecting Users' Legal Rights From Anti-Circumvention Law" },
  { doc: "gpl-3.0", query: "Affero network use", answer: "Use with the GNU Affero General Public License" },
  { doc: "gpl-3.0", query: "installation information user products", answer: "for a User Product means any methods" },
  { doc: "gpl-3.0", query: "terminating the license reinstated", answer: "your license from a particular copyright holder is reinstated" },
  { doc: "mpl-2.0", query: "license termination breach", answer: "will terminate automatically if You fail to comply" },
  { doc: "mpl-2.0", query: "who publishes new license versions", answer: "Mozilla Foundation is the license steward" },
  { doc: "mpl-2.0", query: "liability limits damages", answer: "Limitation of Liability" },
  { doc: "mpl-2.0", query: "distributing source form obligations", answer: "Distribution of Source Form" },
  // Real documents, when fetched.
  { doc: "vicksburg-ocr", query: "shell crater bury a horse", answer: "big enough to bury a horse" },
  { doc: "vicksburg-ocr", query: "sewing buttons camp chores", answer: "sew on buttons" },
  { doc: "geobase-data-model", query: "document revisions history", answer: "REVISION HISTORY" },
  { doc: "geobase-data-model", query: "abbreviation list", answer: "ABBREVIATIONS" },
];

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
