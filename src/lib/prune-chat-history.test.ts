import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  pruneToolOutputsForHistory,
  sanitizeDanglingToolParts,
} from "./prune-chat-history";

function readPageMessage(page: number, text: string): UIMessage {
  return {
    id: `m-${page}`,
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

function firstOutput(messages: UIMessage[]): unknown {
  const part = messages[0]?.parts[0];
  return part && "output" in part ? part.output : undefined;
}

describe("pruneToolOutputsForHistory", () => {
  it("compacts a bulky read output and records the original char count", () => {
    const text = "x".repeat(5234);
    const out = pruneToolOutputsForHistory([readPageMessage(3, text)]);
    expect(firstOutput(out)).toBe(
      "[Read page 3, 5234 chars — omitted from chat history]",
    );
  });

  it("is idempotent: re-pruning does not overwrite the char count (N2 regression)", () => {
    const text = "x".repeat(5234);
    const once = pruneToolOutputsForHistory([readPageMessage(3, text)]);
    const twice = pruneToolOutputsForHistory(once);
    // The summary's own length (~53) must not replace the original 5234.
    expect(firstOutput(twice)).toBe(
      "[Read page 3, 5234 chars — omitted from chat history]",
    );
    // No change on the second pass → the array identity is preserved.
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
    const pruned = pruneToolOutputsForHistory(cancelled);
    // Must stay "[cancelled]", not become `[Search "term", 11 hits — omitted…]`.
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
