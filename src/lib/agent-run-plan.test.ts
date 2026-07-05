import { describe, expect, it } from "vitest";
import {
  extractLastUserTextFromMessages,
  MAX_AGENT_STEPS_FULL,
  MAX_AGENT_STEPS_TARGETED,
  resolveMaxAgentSteps,
  shouldReserveFinalSynthesis,
  shouldSynthesizeAfterTools,
} from "./agent-run-plan";
import type { ModelMessage } from "ai";

describe("agent-run-plan", () => {
  it("extracts last user text from string or parts", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      {
        role: "user",
        content: [{ type: "text", text: "文中有哪些日期？" }],
      },
    ] as ModelMessage[];
    expect(extractLastUserTextFromMessages(messages)).toBe("文中有哪些日期？");
  });

  it("uses fewer steps for targeted factual queries", () => {
    expect(resolveMaxAgentSteps("文中有哪些日期？")).toBe(MAX_AGENT_STEPS_TARGETED);
    expect(resolveMaxAgentSteps("总结整份文档")).toBe(MAX_AGENT_STEPS_FULL);
  });

  it("synthesizes after read tools when the last step has no text", () => {
    expect(
      shouldSynthesizeAfterTools([
        { toolCalls: [{ toolName: "read_pdf_page" }], text: "" },
      ]),
    ).toBe(true);
  });

  it("synthesizes after search when a read tool already ran", () => {
    expect(
      shouldSynthesizeAfterTools([
        { toolCalls: [{ toolName: "search_in_document" }], text: "" },
        { toolCalls: [{ toolName: "read_pdf_page" }], text: "" },
      ]),
    ).toBe(true);
  });

  it("does not synthesize after search alone without a read", () => {
    expect(
      shouldSynthesizeAfterTools([
        { toolCalls: [{ toolName: "search_in_document" }], text: "" },
      ]),
    ).toBe(false);
  });

  it("does not synthesize when the model already wrote an answer", () => {
    expect(
      shouldSynthesizeAfterTools([{ toolCalls: [{}], text: "Here are the dates." }]),
    ).toBe(false);
  });

  it("reserves final synthesis only near the cap", () => {
    expect(shouldReserveFinalSynthesis(5, 6)).toBe(true);
    expect(shouldReserveFinalSynthesis(3, 6)).toBe(false);
  });
});
