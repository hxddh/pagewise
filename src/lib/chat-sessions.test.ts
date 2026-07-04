import { describe, expect, it, beforeEach } from "vitest";
import type { UIMessage } from "ai";
import {
  __resetSessionStoreForTests,
  clearActiveThread,
  loadActiveMessages,
  saveActiveSession,
} from "./chat-sessions";

function msg(id: string, text: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  };
}

describe("saveActiveSession", () => {
  beforeEach(() => {
    __resetSessionStoreForTests({ version: 2, byPath: {} });
  });

  it("persists non-empty messages", async () => {
    await saveActiveSession("/a.pdf", "a.pdf", "default", [msg("1", "hello")]);
    const loaded = await loadActiveMessages("/a.pdf");
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.messages[0].parts[0]).toMatchObject({ text: "hello" });
  });

  it("does not delete history when saving empty messages", async () => {
    await saveActiveSession("/a.pdf", "a.pdf", "default", [msg("1", "keep me")]);
    await saveActiveSession("/a.pdf", "a.pdf", "default", []);
    const loaded = await loadActiveMessages("/a.pdf");
    expect(loaded.messages).toHaveLength(1);
  });

  it("clearActiveThread removes stored thread", async () => {
    await saveActiveSession("/a.pdf", "a.pdf", "default", [msg("1", "bye")]);
    await clearActiveThread("/a.pdf", "default");
    const loaded = await loadActiveMessages("/a.pdf");
    expect(loaded.messages).toHaveLength(0);
    expect(loaded.threads).toHaveLength(0);
  });
});

describe("loadActiveMessages", () => {
  beforeEach(() => {
    __resetSessionStoreForTests({ version: 2, byPath: {} });
  });

  it("loads preferred session id", async () => {
    await saveActiveSession("/a.pdf", "a.pdf", "default", [msg("1", "one")]);
    await saveActiveSession("/a.pdf", "a.pdf", "other", [msg("2", "two")]);
    const loaded = await loadActiveMessages("/a.pdf", "other");
    expect(loaded.sessionId).toBe("other");
    expect(loaded.messages[0].parts[0]).toMatchObject({ text: "two" });
  });
});
