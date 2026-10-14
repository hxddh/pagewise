import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { citationsByPage } from "./page-citations";

const assistant = (id: string, text: string): UIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text }],
});

const user = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

describe("citationsByPage", () => {
  it("maps each cited page to the answer that cited it", () => {
    const map = citationsByPage([
      user("u1", "what about page 12?"),
      assistant("a1", 'As the report says〔p12 "revenue fell"〕.'),
    ]);
    expect(map.get(12)).toEqual([{ messageId: "a1", page: 12, quote: "revenue fell" }]);
  });

  it("expands a page range into its pages", () => {
    const map = citationsByPage([assistant("a1", 'Both〔p3-5 "the series"〕.')]);
    expect([...map.keys()].sort((a, b) => a - b)).toEqual([3, 4, 5]);
    expect(map.get(4)?.[0]?.messageId).toBe("a1");
  });

  it("keeps one entry per answer per page", () => {
    // Three markers on page 12 in one answer are one dot: the dot stands for
    // the answer, not for the marker.
    const map = citationsByPage([
      assistant("a1", 'One〔p12 "a"〕, two〔p12 "b"〕, three〔p12〕.'),
    ]);
    expect(map.get(12)).toHaveLength(1);
  });

  it("keeps answers apart, and in message order", () => {
    const map = citationsByPage([
      assistant("a1", 'First〔p2 "a"〕.'),
      assistant("a2", 'Second〔p2 "b"〕.'),
    ]);
    expect(map.get(2)?.map((c) => c.messageId)).toEqual(["a1", "a2"]);
  });

  it("reads answers, not questions", () => {
    // A reader typing 〔p12 "…"〕 into the composer is not an answer citing it.
    const map = citationsByPage([user("u1", 'Quote me〔p12 "a"〕.')]);
    expect(map.size).toBe(0);
  });

  it("records a citation with no quote as a null quote", () => {
    const map = citationsByPage([assistant("a1", "See 〔p7〕.")]);
    expect(map.get(7)).toEqual([{ messageId: "a1", page: 7, quote: null }]);
  });
});
