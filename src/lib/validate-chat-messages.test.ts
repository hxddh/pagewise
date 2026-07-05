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
});
