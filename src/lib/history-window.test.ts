import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  KEEP_RECENT_TURNS,
  prepareHistoryForModel,
  stripReasoningParts,
  windowHistory,
} from "./history-window";

function user(text: string): UIMessage {
  return { id: `u${text}`, role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

function assistant(text: string, reasoning?: string): UIMessage {
  const parts: UIMessage["parts"] = [];
  if (reasoning) parts.push({ type: "reasoning", text: reasoning } as UIMessage["parts"][number]);
  parts.push({ type: "text", text });
  return { id: `a${text}`, role: "assistant", parts } as UIMessage;
}

describe("stripReasoningParts", () => {
  it("drops thinking from what is sent, which was being re-bought every turn", () => {
    const messages = [
      user("q1"),
      assistant("a1", "a long chain of thought that cost real output tokens"),
      user("q2"),
    ];
    const out = stripReasoningParts(messages);
    expect(out[1]!.parts.map((p) => p.type)).toEqual(["text"]);
    // The answer survives; only the thinking that produced it is dropped.
    expect((out[1]!.parts[0] as { text: string }).text).toBe("a1");
  });

  it("leaves messages that have no reasoning exactly as they were", () => {
    const messages = [user("q"), assistant("a")];
    expect(stripReasoningParts(messages)).toBe(messages);
  });

  it("never touches the user's own words", () => {
    const messages = [user("q1"), assistant("a1", "think")];
    expect(stripReasoningParts(messages)[0]).toBe(messages[0]);
  });
});

describe("windowHistory", () => {
  it("keeps a short conversation whole", () => {
    const messages = [user("q1"), assistant("a1"), user("q2"), assistant("a2")];
    expect(windowHistory(messages)).toBe(messages);
  });

  it("folds the oldest turns into one line rather than growing forever", () => {
    const messages: UIMessage[] = [];
    for (let i = 1; i <= 20; i++) {
      messages.push(user(`question number ${i}`), assistant(`answer ${i}`));
    }

    const out = windowHistory(messages, 5);

    // One summary plus the last five exchanges.
    expect(out).toHaveLength(1 + 5 * 2);
    const note = (out[0]!.parts[0] as { text: string }).text;
    expect(note).toContain("15 exchanges");
    expect(note).toContain("question number 1");
    // The newest turn is untouched and still last.
    expect(out[out.length - 1]).toBe(messages[messages.length - 1]);
  });

  it("summarizes locally — no model call to save model calls", () => {
    const messages: UIMessage[] = [];
    for (let i = 1; i <= 30; i++) messages.push(user(`q${i}`), assistant(`a${i}`));
    const out = windowHistory(messages, 2);
    const note = (out[0]!.parts[0] as { text: string }).text;
    expect(note.length).toBeLessThan(1_200);
  });

  it("uses a default that leaves ordinary conversations alone", () => {
    const messages: UIMessage[] = [];
    for (let i = 0; i < KEEP_RECENT_TURNS; i++) messages.push(user(`q${i}`), assistant(`a${i}`));
    expect(windowHistory(messages)).toBe(messages);
  });
});

describe("prepareHistoryForModel", () => {
  it("does both, and the newest question always survives intact", () => {
    const messages: UIMessage[] = [];
    for (let i = 1; i <= 20; i++) {
      messages.push(user(`q${i}`), assistant(`a${i}`, `thinking about ${i}`));
    }
    messages.push(user("the newest question"));

    const out = prepareHistoryForModel(messages, 3);

    expect(out.some((m) => m.parts.some((p) => p.type === "reasoning"))).toBe(false);
    expect((out[out.length - 1]!.parts[0] as { text: string }).text).toBe(
      "the newest question",
    );
  });
});

describe("stripReasoningParts on a reply that was only thinking", () => {
  it("drops the message rather than sending an empty one", () => {
    // A run stopped while the model was still reasoning leaves an assistant
    // turn with nothing but a reasoning part. Providers reject an empty
    // message, and the send path's empty-message guard runs before this.
    const messages = [
      user("q1"),
      { id: "a", role: "assistant", parts: [{ type: "reasoning", text: "half a thought" }] },
      user("q2"),
    ] as UIMessage[];

    const out = stripReasoningParts(messages);
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.parts.length > 0)).toBe(true);
    expect(out.map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("keeps a reply that had reasoning and an answer", () => {
    const messages = [user("q"), assistant("the answer", "thinking")] as UIMessage[];
    const out = stripReasoningParts(messages);
    expect(out).toHaveLength(2);
    expect(out[1]!.parts).toHaveLength(1);
  });
});
