import { describe, expect, it } from "vitest";
import {
  getInFlightAssistantMessage,
  hasSubstantialAssistantText,
  hasSubstantialAnswerText,
  isAwaitingAssistantReply,
  dropEmptyPartMessages,
  normalizeUIMessage,
  normalizeUIMessages,
} from "./messages-utils";
import type { UIMessage } from "ai";

const userMsg = (id: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: "question" }],
});

const assistantMsg = (id: string, text = ""): UIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text }],
});

describe("in-flight assistant helpers", () => {
  it("detects awaiting assistant when last message is user", () => {
    const messages = [assistantMsg("a1", "previous answer with lots of text"), userMsg("u2")];
    expect(isAwaitingAssistantReply(messages, true)).toBe(true);
    expect(getInFlightAssistantMessage(messages, true)).toBeUndefined();
    expect(hasSubstantialAssistantText(getInFlightAssistantMessage(messages, true))).toBe(
      false,
    );
  });

  it("uses only the streaming assistant row, not the previous turn", () => {
    const messages = [
      assistantMsg("a1", "x".repeat(80)),
      userMsg("u2"),
      assistantMsg("a2", ""),
    ];
    expect(isAwaitingAssistantReply(messages, true)).toBe(false);
    expect(getInFlightAssistantMessage(messages, true)?.id).toBe("a2");
    expect(hasSubstantialAssistantText(getInFlightAssistantMessage(messages, true))).toBe(
      false,
    );
  });
});

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

  it("drops messages with empty parts array", () => {
    expect(
      normalizeUIMessage({ id: "e", role: "assistant", parts: [] }),
    ).toBeNull();
    expect(
      normalizeUIMessages([
        userMsg("u1"),
        { id: "e", role: "assistant", parts: [] },
      ]),
    ).toHaveLength(1);
  });
});

describe("dropEmptyPartMessages", () => {
  it("removes zero-part rows before send/validate", () => {
    const out = dropEmptyPartMessages([
      userMsg("u1"),
      { id: "a1", role: "assistant", parts: [] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("u1");
  });

  it("counts reasoning text toward substantial assistant output", () => {
    const msg: UIMessage = {
      id: "r1",
      role: "assistant",
      parts: [{ type: "reasoning", text: "short note" }],
    };
    expect(hasSubstantialAssistantText(msg)).toBe(true);
    expect(hasSubstantialAnswerText(msg)).toBe(false);
  });
});
