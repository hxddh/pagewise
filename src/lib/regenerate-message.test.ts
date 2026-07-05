import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { findLastMessage } from "./messages-utils";

describe("regenerate message selection", () => {
  it("reads latest messages from a ref, not a stale closure", () => {
    const messagesRef = { current: [] as UIMessage[] };

    messagesRef.current = [
      { id: "a1", role: "assistant", parts: [{ type: "text" as const, text: "old" }] },
      { id: "u1", role: "user", parts: [{ type: "text" as const, text: "thread-a" }] },
    ];

    const staleClosureMessages: UIMessage[] = [
      { id: "u0", role: "user", parts: [{ type: "text", text: "stale" }] },
    ];

    const fromRef = findLastMessage(messagesRef.current, (m) => m.role === "user");
    const fromStale = findLastMessage(staleClosureMessages, (m) => m.role === "user");

    expect(fromRef?.id).toBe("u1");
    expect(fromStale?.id).toBe("u0");
  });
});
