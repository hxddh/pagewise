import { describe, expect, it } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { safeValidateTypes } from "@ai-sdk/provider-utils";
import { modelMessageSchema } from "ai";
import { z } from "zod/v4";
import {
  compactAgentMessages,
  COMPACT_AGGRESSIVE_ESTIMATED_TOKENS,
  COMPACT_AGGRESSIVE_STEP_INPUT_TOKENS,
  estimateMessageTokens,
  hasBudgetExceededInMessages,
  resolveCompactionLevel,
  shouldForceSynthesisStep,
  shouldReserveFinalSynthesis,
  sumStepInputTokens,
} from "./agent-context-compaction";

async function expectValidModelMessages(messages: ModelMessage[]) {
  const validation = await safeValidateTypes({
    value: messages,
    schema: z.array(modelMessageSchema),
  });
  expect(validation.success).toBe(true);
}

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

  it("does not escalate on a cumulative billing sum when live context is small", () => {
    // Three steps that each re-sent ~7k tokens of the same growing context.
    // Cumulative sum is 21k (> the 20k step threshold) but the LIVE context is
    // small, so aggressive compaction must NOT trigger.
    const messages = [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "text", text: "short" }] },
    ] as ModelMessage[];
    const steps = [
      { usage: { inputTokens: 7_000 } },
      { usage: { inputTokens: 7_000 } },
      { usage: { inputTokens: 7_000 } },
    ];
    expect(sumStepInputTokens(steps)).toBe(21_000);
    expect(resolveCompactionLevel(messages, steps, 3)).not.toBe("aggressive");
  });

  it("escalates to aggressive on a large single live step input", () => {
    const messages = [{ role: "user", content: "q" }] as ModelMessage[];
    const steps = [{ usage: { inputTokens: COMPACT_AGGRESSIVE_STEP_INPUT_TOKENS } }];
    expect(resolveCompactionLevel(messages, steps, 1)).toBe("aggressive");
  });

  it("does not force synthesis on the same step that aggressively pruned", () => {
    const messages = [{ role: "user", content: "q" }] as ModelMessage[];
    // Post-tool step, aggressive level, but no budget pressure → keep gathering.
    expect(
      shouldForceSynthesisStep(
        [{ toolCalls: [{}], text: "" }],
        messages,
        "aggressive",
        0,
        120_000,
      ),
    ).toBe(false);
  });

  it("reserves the final allowed step for synthesis", () => {
    expect(shouldReserveFinalSynthesis(13, 14)).toBe(true);
    expect(shouldReserveFinalSynthesis(12, 14)).toBe(false);
    expect(shouldReserveFinalSynthesis(0, 0)).toBe(false);
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
          {
            type: "tool-result",
            toolCallId: "b",
            toolName: "read_pdf_range",
            output: { type: "json", value: { budgetExceeded: true, text: "partial" } },
          },
        ],
      },
    ] as unknown as ModelMessage[];
    expect(hasBudgetExceededInMessages(messages)).toBe(true);
  });

  it("prunes read tools more aggressively than search in normal mode", async () => {
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
    await expectValidModelMessages(compacted);
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
