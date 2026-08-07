import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  KEEP_RECENT_TURNS,
  prepareHistoryForModel,
  stripReasoningParts,
  WINDOW_STEP,
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

    // Dropping is quantized (see WINDOW_STEP): with keep=5 and step=1 this is
    // the old sliding behaviour — one summary plus the last five exchanges.
    const out = windowHistory(messages, 5, 1);

    expect(out).toHaveLength(1 + 5 * 2);
    const note = (out[0]!.parts[0] as { text: string }).text;
    expect(note).toContain("15 exchanges");
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

  it("keeps the note short however long the conversation gets", () => {
    // It quoted every dropped question, up to 60 characters each, in a line
    // whose whole purpose is to be shorter than what it replaces. At a hundred
    // turns that is several thousand characters — and they sit at the front of
    // the prompt, so they are re-sent on every turn.
    const long = (i: number) =>
      `question number ${i} about something with a fairly ordinary length to it`;
    const grow = (turns: number) => {
      const messages: UIMessage[] = [];
      for (let i = 1; i <= turns; i++) messages.push(user(long(i)), assistant(`answer ${i}`));
      return (windowHistory(messages)[0]!.parts[0] as { text: string }).text;
    };

    const at30 = grow(30);
    const at200 = grow(200);
    expect(at200.length).toBeLessThan(600);
    // Longer conversation, same size note: only the count inside it grows.
    expect(at200.length - at30.length).toBeLessThan(20);
    expect(at200).toContain("188 exchanges");
  });
});

describe("windowHistory and the prompt cache", () => {
  const conversation = (turns: number): UIMessage[] => {
    const messages: UIMessage[] = [];
    for (let i = 1; i <= turns; i++) {
      messages.push(user(`question number ${i}`), assistant(`answer ${i}`));
    }
    return messages;
  };

  const noteOf = (out: UIMessage[]) => (out[0]!.parts[0] as { text: string }).text;

  it("does not rewrite the front of the prompt on every turn", () => {
    // This is the bug. The note names the number of dropped turns and quotes
    // them, and it is messages[0] — part of every provider's cache prefix. When
    // the window slid by one turn, that text changed on every turn from the
    // thirteenth onwards, so each question was a full cache miss on the entire
    // conversation. The twelve turns kept "to save tokens" were re-bought at
    // full price every time, which an unwindowed conversation would not have
    // done.
    let rewrites = 0;
    let previous = noteOf(windowHistory(conversation(40)));
    for (let turns = 41; turns <= 60; turns++) {
      const note = noteOf(windowHistory(conversation(turns)));
      if (note !== previous) rewrites += 1;
      previous = note;
    }
    // Twenty turns, one miss per step rather than one per turn.
    expect(rewrites).toBe(20 / WINDOW_STEP);
  });

  it("keeps the whole prefix identical between moves, not just the note", () => {
    // A stable note is worth nothing if the messages behind it shift, so pin
    // the cut point too: consecutive turns inside one step must send the same
    // opening messages, with only the new turn appended at the end.
    const a = windowHistory(conversation(41));
    const b = windowHistory(conversation(42));
    expect(noteOf(b)).toBe(noteOf(a));
    expect(b.slice(1, a.length)).toEqual(a.slice(1));
    expect(b.length).toBe(a.length + 2);
  });

  it("still bounds the conversation as it grows", () => {
    // The point of the window survives quantization: kept turns float between
    // keep and keep + step - 1, and never grow past that.
    for (let turns = 13; turns <= 120; turns++) {
      const out = windowHistory(conversation(turns));
      const kept = out.filter((m) => m.role === "user").length - (out.length === turns * 2 ? 0 : 1);
      expect(kept).toBeLessThanOrEqual(KEEP_RECENT_TURNS + WINDOW_STEP - 1);
      expect(kept).toBeGreaterThanOrEqual(Math.min(turns, KEEP_RECENT_TURNS));
    }
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
