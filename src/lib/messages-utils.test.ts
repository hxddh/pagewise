import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { findLastMessage } from "./messages-utils";

function msg(role: UIMessage["role"], id: string): UIMessage {
  return { id, role, parts: [] };
}

describe("findLastMessage", () => {
  it("returns undefined for empty array", () => {
    expect(findLastMessage([], () => true)).toBeUndefined();
  });

  it("finds last matching message without reversing", () => {
    const messages = [msg("user", "1"), msg("assistant", "2"), msg("user", "3")];
    expect(findLastMessage(messages, (m) => m.role === "user")?.id).toBe("3");
  });

  it("returns undefined when no match", () => {
    const messages = [msg("user", "1"), msg("assistant", "2")];
    expect(findLastMessage(messages, (m) => m.role === "system")).toBeUndefined();
  });
});
