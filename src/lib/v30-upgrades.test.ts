import { afterEach, describe, expect, it } from "vitest";
import {
  clearActiveReaderSelection,
  consumePinnedDraftSelection,
  pinActiveReaderSelectionForDraft,
  setActiveReaderSelection,
} from "./active-selection";
import { buildViewContextInstructions } from "./agent-view-context";
import { claimBefore, coCitationsBefore } from "./answer-tables";
import { checkCitation, clearCitationChecks, tallyCitations, withClaim } from "./citation-check";
import { compactRunMessages } from "./compact-run-messages";
import { docCache } from "./doc-cache";
import { clearFindingAnchors } from "./finding-anchors";
import { polarityMismatch } from "./polarity-check";
import { pruneToolOutputsForHistory } from "./prune-chat-history";
import { quantities, unstatedQuantities } from "./quantities";
import { struckOutMismatch } from "./strikethrough-check";

describe("v30 hardened verification, agent compaction & reader selection upgrades", () => {
  afterEach(() => {
    docCache.clear();
    clearCitationChecks();
    clearFindingAnchors();
    clearActiveReaderSelection();
  });

  it("parses parenthesized accounting negatives without misreading legal numeral restatements", () => {
    expect(unstatedQuantities("Operating margin was -12.5%", "Operating margin was (12.5%).")).toEqual([]);
    expect(
      unstatedQuantities("Operating margin was 12.5%", "Operating margin was (12.5%).").map((q) => q.text),
    ).toEqual(["12.5%"]);
    expect(unstatedQuantities("Net loss was -$1,200", "Adjusted EBITDA: ($1,200).")).toEqual([]);
    // Legal `thirty-six (36) months` stays positive +36, never -36.
    expect(unstatedQuantities("Term is 36 months", "The term is thirty-six (36) months.")).toEqual([]);
    // Dot-separated and US slash dates parse cleanly while Table/Figure labels are stripped.
    expect(unstatedQuantities("Signed on 2025-04-17", "Signed 2025.04.17 (see Table 4).")).toEqual([]);
    expect(quantities("See Figure 2, Table 4, and 图3 for details.")).toEqual([]);
  });

  it("catches clause-scoped exception & obligation flips while preserving conditional permissions", () => {
    expect(
      polarityMismatch(
        "Contractor may subcontract any work freely.",
        "Contractor shall not subcontract any work, except where approved in writing.",
      ),
    ).toEqual(["permitted vs prohibited (subcontract)"]);
    expect(
      polarityMismatch(
        "Contractor may subcontract work if approved in writing.",
        "Contractor shall not subcontract any work, except where approved in writing.",
      ),
    ).toEqual([]);
    expect(
      polarityMismatch(
        "Recipient must disclose Confidential Information.",
        "Recipient shall not disclose Confidential Information.",
      ),
    ).toEqual(["permitted vs prohibited (disclose)"]);
  });

  it("flags 2-character inline redlines (`<s>5%</s>`, `<s>甲方</s>`) unless deletion is disclosed", () => {
    const path = "/docs/redline.pdf";
    docCache.set({
      path,
      name: "redline.pdf",
      kind: "pdf",
      totalPages: 1,
      pages: [{ page: 1, text: "滞纳金比例为 <s>5%</s> 3%，由<s>甲方</s>乙方承担。", source: "native" }],
    });
    expect(struckOutMismatch(path, 1, [], "滞纳金比例为 5%", "滞纳金比例为 5%")).toEqual([
      "~~5%~~",
    ]);
    expect(
      struckOutMismatch(path, 1, [], "滞纳金比例为 5% 3%", "原 5% 已划掉改为 3%"),
    ).toEqual([]);
  });

  it("pools verified co-citations sharing the same claim span without letting unlocated quotes pass", async () => {
    const md =
      'Payment is 30% upfront and 70% on delivery 〔p2 "30% upfront"〕 〔p5 "70% on delivery"〕.';
    const firstAt = md.indexOf("〔p2");
    const secondAt = md.indexOf("〔p5");
    expect(claimBefore(md, firstAt)).toBe("Payment is 30% upfront and 70% on delivery");
    expect(claimBefore(md, secondAt)).toBe("Payment is 30% upfront and 70% on delivery");
    expect(coCitationsBefore(md, firstAt)).toEqual([{ pages: [5], quote: "70% on delivery" }]);
    expect(coCitationsBefore(md, secondAt)).toEqual([{ pages: [2], quote: "30% upfront" }]);

    // When only p2 is checked in isolation without a located sibling on p5, 70% is flagged:
    const isolated = withClaim(
      { status: "located", path: "/co.pdf", page: 2, rects: [], passage: "Deposit: 30% upfront." },
      claimBefore(md, firstAt),
      "30% upfront",
      "/co.pdf",
      coCitationsBefore(md, firstAt),
    );
    expect(isolated?.status).toBe("mismatch");
    expect(tallyCitations("/co.pdf", md).pending).toBe(2);
    void checkCitation;
  });

  it("frees all pages of a compacted batch `read_pdf_page` result for re-reading & keeps per-page digests", () => {
    const batchOutput = {
      pages: [2, 5, 9],
      text:
        "--- Page 2 ---\n# Deposit\n30% upfront " +
        "x".repeat(900) +
        "\n\n--- Page 5 ---\n# Balance\n70% due " +
        "y".repeat(900) +
        "\n\n--- Page 9 ---\n# Governing Law\nBeijing " +
        "z".repeat(900),
    };
    const compactedPages = new Set<number>();
    const msgs = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "t0",
            toolName: "read_pdf_page",
            output: { type: "json", value: batchOutput },
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "reading more pages" }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "t1",
            toolName: "read_pdf_page",
            output: { type: "json", value: { page: 21, text: "w".repeat(2_000) } },
          },
        ],
      },
    ];
    compactRunMessages(msgs as never, 1_500, (pages) => {
      for (const p of pages) compactedPages.add(p);
    });
    expect([...compactedPages].sort((a, b) => a - b)).toEqual([2, 5, 9]);

    const uiPruned = pruneToolOutputsForHistory([
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-read_pdf_page",
            toolCallId: "t0",
            state: "output-available",
            input: { pages: [2, 5, 9] },
            output: batchOutput,
          },
        ],
      },
      { id: "u2", role: "user", parts: [{ type: "text", text: "follow up" }] },
      { id: "a2", role: "assistant", parts: [{ type: "text", text: "ok" }] },
    ] as never);
    const summaryText = JSON.stringify(uiPruned[0]);
    expect(summaryText).toContain("Deposit");
    expect(summaryText).toContain("Governing Law");
  });

  it("pins 'Ask about this' draft selections while ignoring off-screen selections on other pages", () => {
    const path = "/docs/paper.pdf";
    docCache.set({
      path,
      name: "paper.pdf",
      kind: "pdf",
      totalPages: 10,
      pages: Array.from({ length: 10 }, (_, i) => ({ page: i + 1, text: `Page ${i + 1} body`, source: "native" })),
    });
    // Live selection on page 2 is ignored when viewing page 6:
    setActiveReaderSelection({ path, page: 2, text: "stale selection", kind: "text" });
    const instructionsOnP6 = buildViewContextInstructions({
      path,
      docName: "paper.pdf",
      viewingPage: 6,
      totalPages: 10,
      userText: "summarize this page",
      includeViewingPage: false,
    });
    expect(instructionsOnP6).not.toContain("stale selection");

    // Pinned draft selection survives clearing live DOM selection and is consumed once:
    pinActiveReaderSelectionForDraft({ path, page: 2, text: "pinned quote", kind: "text" });
    setActiveReaderSelection(null);
    const consumed = consumePinnedDraftSelection(path);
    expect(consumed?.text).toBe("pinned quote");
    expect(consumePinnedDraftSelection(path)).toBeNull();
  });
});
