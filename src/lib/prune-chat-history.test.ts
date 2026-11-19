import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  compactToolOutput,
  pruneToolOutputsForHistory,
  sanitizeDanglingToolParts,
} from "./prune-chat-history";

function readPageMessage(page: number, text: string, id = `m-${page}`): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-read_pdf_page",
        toolCallId: `t-${page}`,
        state: "output-available",
        input: { page },
        output: text,
      },
    ],
  } as UIMessage;
}

function firstOutput(messages: UIMessage[], index = 0): unknown {
  const part = messages[index]?.parts[0];
  return part && "output" in part ? part.output : undefined;
}

describe("pruneToolOutputsForHistory", () => {
  it("keeps the latest assistant turn warm within WARM_TURN_MAX_CHARS for follow-ups", () => {
    const text = "x".repeat(5234);
    const out = pruneToolOutputsForHistory([readPageMessage(3, text)]);
    expect(firstOutput(out)).toBe(text);
  });

  it("compacts older assistant turns (or warmMaxChars=0) with char count and digest", () => {
    const text = "x".repeat(5234);
    const out = pruneToolOutputsForHistory([
      readPageMessage(3, text, "a1"),
      { id: "a2", role: "assistant", parts: [{ type: "text", text: "Done." }] } as UIMessage,
    ]);
    expect(firstOutput(out, 0)).toBe(
      "[Read page 3, 5234 chars — re-read page 3 to quote verbatim]",
    );

    const rich = "--- Page 2 ---\n# 4 Payment Schedule\n| Stage | Share |\nDeposit is 30% within 5 days.";
    const summary = compactToolOutput("read_pdf_page", { page: 2 }, rich);
    expect(summary).toContain("4 Payment Schedule");
    expect(summary).toContain("30%");
    expect(summary).toMatch(/— re-read page 2 to quote verbatim\]$/);
  });

  it("records actual truncated range pages instead of claiming unread pages were read", () => {
    const raw = "--- Page 1 ---\nIntro\n\n--- Page 2 ---\nTerms";
    const summary = compactToolOutput(
      "read_pdf_range",
      { start: 1, end: 10 },
      { text: raw, startPage: 1, endPage: 2, truncated: true },
    );
    expect(summary).toContain("pages 1–2 (truncated from 1–10)");
  });

  it("is idempotent: re-pruning does not overwrite the char count (N2 regression)", () => {
    const text = "x".repeat(5234);
    const once = pruneToolOutputsForHistory([readPageMessage(3, text)], 0);
    const twice = pruneToolOutputsForHistory(once, 0);
    expect(firstOutput(twice)).toBe(
      "[Read page 3, 5234 chars — re-read page 3 to quote verbatim]",
    );
    expect(twice).toBe(once);
  });

  it("leaves a synthesized [cancelled] output as-is instead of fabricating counts", () => {
    const cancelled = sanitizeDanglingToolParts([
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-search_in_document",
            toolCallId: "t1",
            state: "input-available",
            input: { query: "term" },
          },
        ],
      } as UIMessage,
    ]);
    const pruned = pruneToolOutputsForHistory(cancelled, 0);
    expect(firstOutput(pruned)).toBe("[cancelled]");
  });
});

describe("sanitizeDanglingToolParts", () => {
  it("synthesizes cancelled output for dangling tool parts", () => {
    const messages: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-read_pdf_page",
            toolCallId: "t1",
            state: "input-available",
            input: { page: 1 },
          },
        ],
      },
    ];
    const out = sanitizeDanglingToolParts(messages);
    const part = out[0]?.parts[0];
    expect(part && "output" in part && part.output).toBe("[cancelled]");
    expect(part && "state" in part && part.state).toBe("output-available");
  });
});

describe("read_figure output", () => {
  it("survives pruning, because regenerating it costs another billed call", () => {
    const description = "A bar chart comparing revenue across three quarters.";
    const messages = [
      {
        id: "1",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-read_figure" as const,
            toolCallId: "c1",
            state: "output-available" as const,
            input: { page: 4 },
            output: { page: 4, figureIndex: 1, figureCount: 2, description },
          },
        ],
      },
    ];
    const pruned = pruneToolOutputsForHistory(messages as never, 0);
    const part = (pruned[0]!.parts[0] as { output: { description: string } }).output;
    expect(part.description).toBe(description);
  });
});
