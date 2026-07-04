import { describe, expect, it } from "vitest";
import { normalizeUIMessage, normalizeUIMessages } from "./messages-utils";

describe("normalizeUIMessages", () => {
  it("keeps valid parts-based messages", () => {
    const msg = normalizeUIMessage({
      id: "1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    expect(msg?.parts).toHaveLength(1);
  });

  it("migrates legacy content string to text part", () => {
    const msg = normalizeUIMessage({
      id: "2",
      role: "assistant",
      content: "hello",
    });
    expect(msg?.parts[0]).toMatchObject({ type: "text", text: "hello" });
  });

  it("preserves message metadata", () => {
    const msg = normalizeUIMessage({
      id: "3",
      role: "assistant",
      parts: [{ type: "text", text: "ok" }],
      metadata: { inputTokens: 10, outputTokens: 5, model: "gpt-4o-mini" },
    });
    expect(msg?.metadata).toMatchObject({ inputTokens: 10, model: "gpt-4o-mini" });
  });

  it("drops invalid rows", () => {
    expect(normalizeUIMessages([null, { id: "x", role: "nope" }])).toHaveLength(0);
  });
});
