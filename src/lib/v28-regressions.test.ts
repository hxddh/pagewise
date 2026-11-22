// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { docCache } from "./doc-cache";
import { struckOutMismatch } from "./strikethrough-check";
import { withClaim, type CitationCheck } from "./citation-check";
import { quantities, unstatedQuantities } from "./quantities";
import { citationsToText, extractCitations, sentenceBefore } from "./citations";
import { answerSentences } from "./answer-sentences";
import {
  __resetMarkStoreForTests,
  addMark,
  canRedoMarkChange,
  canUndoMarkChange,
  getMarks,
  redoMarkChange,
  removeMark,
  setMarkNote,
  undoMarkChange,
} from "./mark-store";
import { rankPages } from "./ranked-search";
import { populateOcrTextLayer } from "./ocr/ocr-text-layer";
import {
  beginSteerRun,
  clearSteerNotes,
  emitReclaimedSteer,
  reclaimUndeliveredNotes,
  steerCurrentRun,
  subscribeReclaimedSteer,
  withSteerMessage,
} from "./agent-steer";
import { coerceNumericToolInput } from "./agent-tool-repair";
import { parseClaimReviewText } from "./claim-review";

describe("v28 regressions", () => {
  beforeEach(() => {
    __resetMarkStoreForTests();
    clearSteerNotes();
  });

  describe("parseClaimReviewText", () => {
    it("parses JSON verdicts wrapped in <think> reasoning and markdown fences", () => {
      const raw = `<think>Checking the clause carefully...</think>\n\`\`\`json\n{"verdict":"contradicts","why":"The clause states 60 days, not 30 days."}\n\`\`\``;
      expect(parseClaimReviewText(raw)).toEqual({
        verdict: "contradicts",
        why: "The clause states 60 days, not 30 days.",
      });
    });
  });

  describe("strikethrough safety (Choice 1)", () => {
    const docPath = "/tmp/redline-contract.pdf";

    beforeEach(() => {
      docCache.set({
        path: docPath,
        name: "redline-contract.pdf",
        kind: "pdf",
        totalPages: 2,
        pages: [
          {
            page: 1,
            text: "Section 4. Payment is due within <s>30 calendar days</s> 60 calendar days of invoice.",
            source: "native",
          },
          {
            page: 2,
            text: "Late fee is five percent per month.",
            source: "native",
          },
        ],
        annotations: [
          {
            id: "a1",
            page: 2,
            subtype: "StrikeOut",
            contents: "",
            author: "Counsel",
            quoted: "five percent per month",
            rect: { x: 70, y: 500, width: 140, height: 12 },
          },
        ],
      });
    });

    it("downgrades located check to mismatch when citing <s>...</s> text without disclosing deletion", () => {
      const base: CitationCheck = {
        status: "located",
        path: docPath,
        page: 1,
        rects: [{ x: 100, y: 600, width: 90, height: 10 }],
        passage: "Section 4. Payment is due within 30 calendar days 60 calendar days of invoice.",
      };
      const undiscolosed = withClaim(base, "Payment is due within 30 calendar days.", "30 calendar days");
      expect(undiscolosed?.status).toBe("mismatch");
      expect(undiscolosed?.unstated).toEqual(["~~30 calendar days~~"]);

      const disclosedEn = withClaim(
        base,
        "The 30 calendar days clause was struck out in the amendment.",
        "30 calendar days",
      );
      expect(disclosedEn?.status).toBe("located");

      const disclosedZh = withClaim(
        base,
        "原合同中 30 calendar days 的付款期已被划线删除。",
        "30 calendar days",
      );
      expect(disclosedZh?.status).toBe("located");
    });

    it("flags PDF /StrikeOut markup annotations overlapping the located run", () => {
      const reasons = struckOutMismatch(
        docPath,
        2,
        [{ x: 72, y: 500, width: 120, height: 12 }],
        "five percent per month",
        "A late fee of five percent per month applies.",
      );
      expect(reasons).toEqual(["~~five percent per month~~"]);
    });
  });

  describe("quantities & currency/dimension precision", () => {
    it("distinguishes CJK foreign currencies, 万亿, and suffix currencies", () => {
      expect(unstatedQuantities("合同金额为 120万美元", "合同总价：$1,200,000")).toEqual([]);
      expect(unstatedQuantities("合同金额为 120万美元", "合同总价：1,200,000元").map((q) => q.text)).toEqual([
        "120万",
      ]);
      expect(unstatedQuantities("Budget is $5,000,000", "Total cap: 5M USD")).toEqual([]);
      expect(quantities("规模达 1.5万亿")[0]?.value).toBe(1.5e12);
      expect(quantities("营收突破三千万")[0]?.value).toBe(3e7);
    });

    it("does not equate dimensionless counts with seconds-normalized durations", () => {
      expect(unstatedQuantities("共处理 86,400 条记录", "应在 1 日内完成").length).toBe(1);
      expect(unstatedQuantities("通知期为 72 小时", "应提前 3 日书面通知")).toEqual([]);
    });
  });

  describe("citations & abbreviation-safe sentence splitting", () => {
    it("parses comma-separated page lists and guillemets", () => {
      const cites = extractCitations("See terms〔pp. 2, 4-5 «exact clause text»〕.");
      expect(cites).toHaveLength(1);
      expect(cites[0]?.pages).toEqual([2, 4, 5]);
      expect(cites[0]?.quote).toBe("exact clause text");
      expect(citationsToText("See〔p2, 5 \"clause\"〕")).toBe("See [pp. 2, 5: “clause”]");
    });

    it("keeps sentences intact across Sec., Dr., e.g., and et al.", () => {
      const md = 'Under Sec. 4.2, Dr. Lee noted e.g. a $500 fee〔p3 "fee of $500"〕.';
      const markerAt = md.indexOf("〔");
      expect(sentenceBefore(md, markerAt)).toBe("Under Sec. 4.2, Dr. Lee noted e.g. a $500 fee");
      const sents = answerSentences(md);
      expect(sents).toHaveLength(1);
    });
  });

  describe("mark-store Undo/Redo stack", () => {
    it("undoes and redoes mark creation, coalesced note edits, and deletion", () => {
      const path = "/tmp/doc.pdf";
      const created = addMark(path, {
        page: 1,
        rects: [{ x: 10, y: 20, width: 100, height: 12 }],
        text: "key clause",
        stamp: "s1",
      });
      expect(created).not.toBeNull();
      expect(canUndoMarkChange(path)).toBe(true);

      // Rapid note edits coalesce into a single undo snapshot.
      setMarkNote(path, created!.id, "n");
      setMarkNote(path, created!.id, "note full");
      expect(getMarks(path)[0]?.note).toBe("note full");

      removeMark(path, created!.id);
      expect(getMarks(path)).toHaveLength(0);

      // Undo deletion -> mark returns with its note!
      expect(undoMarkChange(path)).toBe(true);
      expect(getMarks(path)).toHaveLength(1);
      expect(getMarks(path)[0]?.note).toBe("note full");

      // Undo coalesced note edit -> empty note!
      expect(undoMarkChange(path)).toBe(true);
      expect(getMarks(path)[0]?.note).toBe("");

      // Redo note edit -> "note full"
      expect(canRedoMarkChange(path)).toBe(true);
      expect(redoMarkChange(path)).toBe(true);
      expect(getMarks(path)[0]?.note).toBe("note full");
    });
  });

  describe("BM25 CJK query separation & OCR CJK text layer", () => {
    it("does not fuse space-separated CJK query keywords into a phantom bigram", () => {
      const pages = [
        { page: 1, text: "甲方享有解除权。另一款规定违约责任。" },
        { page: 2, text: "本页无关内容。" },
      ];
      const hits = rankPages(pages, "甲方 违约");
      expect(hits[0]?.page).toBe(1);
      expect(hits[0]?.terms).not.toContain("方违");
    });

    it("omits inter-box spaces between CJK characters while keeping Latin word spaces", () => {
      const div = document.createElement("div");
      populateOcrTextLayer(
        div,
        [
          { text: "甲", bbox: { x0: 10, y0: 10, x1: 24, y1: 24 } },
          { text: "方", bbox: { x0: 25, y0: 10, x1: 39, y1: 24 } },
          { text: "OpenAI", bbox: { x0: 45, y0: 10, x1: 95, y1: 24 } },
          { text: "Inc", bbox: { x0: 100, y0: 10, x1: 130, y1: 24 } },
        ],
        200,
        300,
        { imageSize: { width: 200, height: 300 } },
      );
      expect(div.textContent).toBe("甲方 OpenAI Inc");
    });
  });

  describe("steer reclamation (Choice 2) & tool repair", () => {
    it("reclaims undelivered steer notes when a run ends after its final step", () => {
      const reclaimed: string[] = [];
      const unsub = subscribeReclaimedSteer((text) => reclaimed.push(text));
      beginSteerRun(1);
      steerCurrentRun("check page 4");
      // Delivered in step 1:
      withSteerMessage([{ role: "user", content: "hi" }], 1);
      expect(reclaimUndeliveredNotes()).toEqual([]);

      // Queued during final synthesis step (never consumed by prepareStep):
      steerCurrentRun("also check indemnity cap");
      const left = reclaimUndeliveredNotes();
      expect(left).toEqual(["also check indemnity cap"]);
      emitReclaimedSteer(left.join("\n"));
      expect(reclaimed).toEqual(["also check indemnity cap"]);
      unsub();
    });

    it("repairs string figure index and scalar/CSV pages in tool inputs", () => {
      expect(coerceNumericToolInput('{"page":"3","index":"1"}')).toBe('{"page":3,"index":1}');
      expect(coerceNumericToolInput('{"pages":"2, 4"}')).toBe('{"pages":[2,4]}');
      expect(coerceNumericToolInput('{"pages":7}')).toBe('{"pages":[7]}');
    });
  });
});
