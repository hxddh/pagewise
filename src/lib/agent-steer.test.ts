import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSteerNotes,
  hasSteerNotes,
  MAX_STEER_CHARS,
  MAX_STEER_NOTES,
  queueSteerNote,
  steerMessageFor,
  steerMessageText,
  takeSteerNotes,
  withSteerMessage,
} from "./agent-steer";

/**
 * A correction typed during a run has to reach that run, once, and no other.
 *
 * The generation is the whole guarantee here. Runs overlap in practice — a note
 * can be typed in the moment a run is finishing, and delivering it to the next
 * run would put words in the reader's mouth: they were correcting an answer they
 * have already received.
 */

beforeEach(() => clearSteerNotes());

describe("queueSteerNote", () => {
  it("keeps a note for the run it was typed during", () => {
    expect(queueSteerNote(3, "look at page 40 instead")).toBe("look at page 40 instead");
    expect(hasSteerNotes(3)).toBe(true);
  });

  it("ignores an empty note", () => {
    expect(queueSteerNote(1, "   ")).toBeNull();
    expect(hasSteerNotes(1)).toBe(false);
  });

  it("truncates a note rather than carrying an essay into the loop", () => {
    const long = "x".repeat(MAX_STEER_CHARS + 200);
    expect(queueSteerNote(1, long)).toHaveLength(MAX_STEER_CHARS);
  });

  it("stops accepting notes once a run has had its share", () => {
    for (let i = 0; i < MAX_STEER_NOTES; i++) {
      expect(queueSteerNote(1, `note ${i}`)).not.toBeNull();
    }
    expect(queueSteerNote(1, "one more")).toBeNull();
    // A different run has its own allowance.
    expect(queueSteerNote(2, "other run")).toBe("other run");
  });
});

describe("takeSteerNotes", () => {
  it("delivers a note exactly once", () => {
    queueSteerNote(7, "skip the appendix");
    expect(takeSteerNotes(7)).toEqual(["skip the appendix"]);
    // Delivering it again would read to the model as the reader repeating
    // themselves — and it is already in the messages of the step that carried it.
    expect(takeSteerNotes(7)).toEqual([]);
  });

  it("does not hand one run's note to another", () => {
    queueSteerNote(1, "for run one");
    expect(takeSteerNotes(2)).toEqual([]);
    expect(takeSteerNotes(1)).toEqual(["for run one"]);
  });

  it("leaves other runs' notes in place when one run takes its own", () => {
    queueSteerNote(1, "one");
    queueSteerNote(2, "two");
    expect(takeSteerNotes(1)).toEqual(["one"]);
    expect(hasSteerNotes(2)).toBe(true);
  });

  it("keeps the order they were typed in", () => {
    queueSteerNote(1, "first");
    queueSteerNote(1, "second");
    expect(takeSteerNotes(1)).toEqual(["first", "second"]);
  });
});

describe("clearSteerNotes", () => {
  it("drops one run's notes without touching another's", () => {
    queueSteerNote(1, "a");
    queueSteerNote(2, "b");
    clearSteerNotes(1);
    expect(hasSteerNotes(1)).toBe(false);
    expect(hasSteerNotes(2)).toBe(true);
  });

  it("drops everything when given no run", () => {
    queueSteerNote(1, "a");
    queueSteerNote(2, "b");
    clearSteerNotes();
    expect(hasSteerNotes(1)).toBe(false);
    expect(hasSteerNotes(2)).toBe(false);
  });
});

describe("steerMessageFor", () => {
  it("builds a user message the loop can carry, and empties the queue", () => {
    queueSteerNote(5, "page 40, not 4");
    const message = steerMessageFor(5);
    expect(message?.role).toBe("user");
    expect(message?.content[0]?.text).toContain("page 40, not 4");
    expect(hasSteerNotes(5)).toBe(false);
  });

  it("returns nothing when the run has no correction waiting", () => {
    expect(steerMessageFor(5)).toBeNull();
  });

  it("tells the model not to start over", () => {
    // Without this the correction reads as a second question, and the model
    // answers it by re-reading everything — which is the cost the whole feature
    // exists to avoid.
    const text = steerMessageText(["page 40"]);
    expect(text).toContain("do not restart");
    expect(text).toContain("do not re-read pages you have already read");
  });

  it("lists several corrections rather than running them together", () => {
    const text = steerMessageText(["skip the appendix", "page 40, not 4"]);
    expect(text).toContain("- skip the appendix");
    expect(text).toContain("- page 40, not 4");
  });
});

describe("withSteerMessage", () => {
  // A step's messages, shaped the way the loop actually hands them over: the
  // assistant asks for a tool, the tool answers, and the array ends there.
  const conversation = () => [
    { role: "user", content: [{ type: "text", text: "what does it say about risk?" }] },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c1", toolName: "read_pdf_page" }],
    },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", output: "…" }] },
  ];

  const pairingHolds = (messages: readonly { role: string; content: unknown }[]) => {
    // Every tool-call id must be answered by a tool-result, and nothing may sit
    // between an assistant's calls and the tool message answering them.
    for (let i = 0; i < messages.length; i++) {
      const content = messages[i]!.content;
      if (!Array.isArray(content)) continue;
      const calls = content.filter((p) => (p as { type?: string }).type === "tool-call");
      if (calls.length === 0) continue;
      const next = messages[i + 1];
      if (next?.role !== "tool") return false;
      const answered = new Set(
        (next.content as Array<{ toolCallId?: string }>).map((p) => p.toolCallId),
      );
      if (!calls.every((c) => answered.has((c as { toolCallId?: string }).toolCallId))) {
        return false;
      }
    }
    return true;
  };

  it("puts the correction last, so nothing lands between a call and its result", () => {
    // This is the reason the note is appended rather than inserted. prepareStep's
    // other transform only ever rewrites a value inside a result, never adds a
    // message — a message in the wrong place is rejected by the provider.
    queueSteerNote(1, "page 40, not 4");
    const out = withSteerMessage(conversation(), 1) as Array<{
      role: string;
      content: unknown;
    }>;
    expect(out).toHaveLength(4);
    expect(out[3]!.role).toBe("user");
    expect(pairingHolds(out)).toBe(true);
  });

  it("leaves the messages exactly as they were when nothing is queued", () => {
    const input = conversation();
    expect(withSteerMessage(input, 1)).toBe(input);
  });

  it("does not touch the earlier messages", () => {
    queueSteerNote(1, "skip the appendix");
    const input = conversation();
    const out = withSteerMessage(input, 1) as unknown[];
    expect(out.slice(0, 3)).toEqual(input);
  });

  it("carries a note from this run and not another's", () => {
    queueSteerNote(2, "for the next run");
    const input = conversation();
    expect(withSteerMessage(input, 1)).toBe(input);
    expect((withSteerMessage(input, 2) as unknown[]).length).toBe(4);
  });

  it("survives an empty message list", () => {
    queueSteerNote(1, "hello");
    expect((withSteerMessage(undefined, 1) as unknown[]).length).toBe(1);
  });
});
