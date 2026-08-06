import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { searchMessages, stepMatch, visibleText } from "./conversation-search";

function msg(id: string, parts: UIMessage["parts"]): UIMessage {
  return { id, role: "assistant", parts } as UIMessage;
}

const text = (t: string) => ({ type: "text" as const, text: t });

describe("searchMessages", () => {
  const messages = [
    msg("a", [text("The discount rate is given on page 12.")]),
    msg("b", [text("Nothing relevant here.")]),
    msg("c", [text("A different DISCOUNT appears in the appendix.")]),
  ];

  it("finds every message containing the phrase, ignoring case", () => {
    expect(searchMessages(messages, "discount").map((m) => m.id)).toEqual(["a", "c"]);
    expect(searchMessages(messages, "DISCOUNT").map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("returns nothing for an empty or whitespace query", () => {
    expect(searchMessages(messages, "")).toEqual([]);
    expect(searchMessages(messages, "   ")).toEqual([]);
  });

  it("carries an excerpt so a hit is recognisable without opening the turn", () => {
    const [first] = searchMessages(messages, "rate");
    expect(first?.excerpt).toContain("discount rate");
  });

  it("elides only the side it actually cut", () => {
    const long = msg("d", [text(`${"x".repeat(200)} needle ${"y".repeat(200)}`)]);
    const [hit] = searchMessages([long], "needle");
    expect(hit?.excerpt.startsWith("…")).toBe(true);
    expect(hit?.excerpt.endsWith("…")).toBe(true);

    const short = msg("e", [text("needle")]);
    expect(searchMessages([short], "needle")[0]?.excerpt).toBe("needle");
  });

  it("searches only what the reader can see", () => {
    // Reasoning is behind a fold and tool results are machinery; a hit there
    // would send the reader to a turn where the word is nowhere on screen.
    const mixed = msg("f", [
      { type: "reasoning", text: "pondering the discount" },
      text("The answer is 4%."),
    ] as UIMessage["parts"]);
    expect(searchMessages([mixed], "discount")).toEqual([]);
    expect(searchMessages([mixed], "4%").map((m) => m.id)).toEqual(["f"]);
  });

  it("reads a legacy string message", () => {
    const legacy = { id: "g", role: "user", content: "older format" } as unknown as UIMessage;
    expect(visibleText(legacy)).toBe("older format");
    expect(searchMessages([legacy], "older").map((m) => m.id)).toEqual(["g"]);
  });
});

describe("stepMatch", () => {
  const three = [
    { id: "a", index: 0, excerpt: "" },
    { id: "b", index: 0, excerpt: "" },
    { id: "c", index: 0, excerpt: "" },
  ];

  it("cycles forward and back through the hits", () => {
    expect(stepMatch(three, 0, 1)).toBe(1);
    expect(stepMatch(three, 1, -1)).toBe(0);
  });

  it("wraps at both ends — a hit list is a loop, unlike the conversation", () => {
    expect(stepMatch(three, 2, 1)).toBe(0);
    expect(stepMatch(three, 0, -1)).toBe(2);
  });

  it("has nowhere to go with no matches", () => {
    expect(stepMatch([], 0, 1)).toBe(-1);
  });
});
