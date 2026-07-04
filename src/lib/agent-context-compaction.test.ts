import { describe, expect, it } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  COMPACT_AGGRESSIVE_ESTIMATED_TOKENS,
  compactAgentMessages,
  estimateMessageTokens,
  hasBudgetExceededInMessages,
  resolveCompactionLevel,
  shouldForceSynthesisStep,
  sumStepInputTokens,
} from "./agent-context-compaction";

describe("agent-context-compaction", () => {
  it("estimates tokens from message JSON size", () => {
    const messages = [{ role: "user", content: "x".repeat(400) }] as ModelMessage[];
    expect(estimateMessageTokens(messages)).toBeGreaterThan(90);
  });

  it("sums per-step input usage", () => {
    expect(
      sumStepInputTokens([
        { usage: { inputTokens: 1000 } },
        { usage: { inputTokens: 2500 } },
      ]),
    ).toBe(3500);
  });

  it("escalates to aggressive compaction on high estimated tokens", () => {
    const payload = "x".repeat(COMPACT_AGGRESSIVE_ESTIMATED_TOKENS * 4);
    const huge = [{ role: "user", content: payload }] as ModelMessage[];
    expect(resolveCompactionLevel(huge, [], 0)).toBe("aggressive");
  });

  it("detects budgetExceeded in tool results", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "a",
            toolName: "read_pdf_range",
            output: { budgetExceeded: true, text: "partial" },
          },
        ],
      },
    ] as unknown as ModelMessage[];
    expect(hasBudgetExceededInMessages(messages)).toBe(true);
  });

  it("prunes read tools more aggressively than search in normal mode", () => {
    const longText = "z".repeat(800);
    const messages = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "r1",
            toolName: "read_pdf_page",
            input: { page: 1 },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "r1",
            toolName: "read_pdf_page",
            output: { text: longText },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "s1",
            toolName: "search_in_document",
            input: { query: "revenue" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "s1",
            toolName: "search_in_document",
            output: [{ page: 2, text: "hit" }],
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "draft" }] },
    ] as ModelMessage[];

    const compacted = compactAgentMessages(messages, "normal", false, 2);
    const serialized = JSON.stringify(compacted);
    expect(serialized).not.toContain(longText);
    expect(serialized).toContain("search_in_document");
  });

  it("forces synthesis after budget exceeded tool result", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "a",
            toolName: "read_pdf_range",
            output: { budgetExceeded: true },
          },
        ],
      },
    ] as unknown as ModelMessage[];

    expect(
      shouldForceSynthesisStep(
        [{ toolCalls: [{}], text: "" }],
        messages,
        "normal",
        0,
        120_000,
      ),
    ).toBe(true);
  });
});
