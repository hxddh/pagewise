import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { sanitizeDanglingToolParts } from "./prune-chat-history";

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
