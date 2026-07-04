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

  it("drops invalid rows", () => {
    expect(normalizeUIMessages([null, { id: "x", role: "nope" }])).toHaveLength(0);
  });
});
