import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { validateChatMessagesForSend } from "./validate-chat-messages";

const user = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

describe("validateChatMessagesForSend", () => {
  it("accepts a minimal valid thread", async () => {
    const out = await validateChatMessagesForSend({
      messages: [user("u1", "hello")],
      provider: "openai",
    });
    expect(out).toHaveLength(1);
  });

  it("repairs dangling tool parts after stop mid-stream", async () => {
    const out = await validateChatMessagesForSend({
      messages: [
        user("u1", "read page 1"),
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "tool-read_pdf_page",
              toolCallId: "call-1",
              state: "input-available",
              input: { path: "/a.pdf", page: 1 },
            },
          ],
        },
      ],
      provider: "openai",
    });
    expect(out).toHaveLength(2);
    const toolPart = out[1]?.parts[0];
    expect(toolPart?.type).toBe("tool-read_pdf_page");
    if (toolPart && "state" in toolPart) {
      expect(toolPart.state).toBe("output-available");
    }
  });

  it("drops empty assistant placeholders", async () => {
    const out = await validateChatMessagesForSend({
      messages: [user("u1", "hello"), { id: "a1", role: "assistant", parts: [] }],
      provider: "openai",
    });
    expect(out).toHaveLength(1);
  });

  it("removes a tool part whose input never finished streaming", async () => {
    const out = await validateChatMessagesForSend({
      messages: [
        user("u1", "read page 1"),
        {
          id: "a1",
          role: "assistant",
          parts: [
            { type: "text", text: "Let me read that." },
            {
              // Stop mid-argument-stream: input is incomplete and would fail
              // the tool schema if synthesized into a completed call.
              type: "tool-read_pdf_page",
              toolCallId: "call-1",
              state: "input-streaming",
              input: undefined,
            },
          ],
        },
      ] as UIMessage[],
      provider: "openai",
    });
    expect(out).toHaveLength(2);
    expect(out[1]?.parts.some((p) => p.type.startsWith("tool-"))).toBe(false);
  });

  it("never drops the just-typed trailing user message during repair", async () => {
    const out = await validateChatMessagesForSend({
      messages: [
        user("u1", "first question"),
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              // Corrupt completed call: schema-invalid input that repair can
              // only resolve by dropping a row — it must drop THIS row, not
              // the trailing user turn.
              type: "tool-read_pdf_page",
              toolCallId: "call-1",
              state: "output-available",
              input: {},
              output: "[cancelled]",
            },
          ],
        },
        user("u2", "second question"),
      ] as UIMessage[],
      provider: "openai",
    });
    const texts = out.flatMap((m) =>
      m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])),
    );
    expect(texts).toContain("second question");
  });
});
