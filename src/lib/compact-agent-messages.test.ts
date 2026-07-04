import { describe, expect, it } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { compactStaleToolResults } from "./compact-agent-messages";

describe("compactStaleToolResults", () => {
  it("truncates read tool outputs in older messages", () => {
    const longText = "x".repeat(2000);
    const messages = [
      { role: "user", content: "find revenue" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "a",
            toolName: "read_pdf_range",
            input: { start: 1, end: 2 },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "a",
            toolName: "read_pdf_range",
            output: { type: "json", value: { text: longText } },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "next" }] },
    ] as ModelMessage[];

    const compacted = compactStaleToolResults(messages, 1);
    const toolMsg = compacted[2];
    expect(toolMsg?.role).toBe("tool");
    if (toolMsg && Array.isArray(toolMsg.content)) {
      const part = toolMsg.content[0];
      expect(part?.type).toBe("tool-result");
      if (part?.type === "tool-result") {
        const serialized = JSON.stringify(part.output);
        expect(serialized.length).toBeLessThan(JSON.stringify({ text: longText }).length);
        expect(serialized).toContain("[omitted from earlier step]");
      }
    }
  });

  it("truncates search tool outputs in older messages", () => {
    const hits = Array.from({ length: 20 }, (_, i) => ({
      page: i + 1,
      score: 0.9,
      text: "x".repeat(200),
    }));
    const messages = [
      { role: "user", content: "find revenue" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "a",
            toolName: "search_in_document",
            output: hits,
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "next" }] },
    ] as ModelMessage[];

    const compacted = compactStaleToolResults(messages, 1);
    const toolMsg = compacted[1];
    expect(toolMsg?.role).toBe("tool");
    if (toolMsg && Array.isArray(toolMsg.content)) {
      const part = toolMsg.content[0];
      expect(part?.type).toBe("tool-result");
      if (part?.type === "tool-result") {
        const serialized = JSON.stringify(part.output);
        expect(serialized.length).toBeLessThan(JSON.stringify(hits).length);
        expect(serialized).toContain("[omitted from earlier step]");
      }
    }
  });
});
