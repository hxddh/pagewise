import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TextItemRect } from "./types";

let pages: Record<number, TextItemRect[]> = {};
vi.mock("./pdf", () => ({
  pageTextItems: async (_path: string, page: number) => pages[page] ?? [],
}));

import { clearFindingAnchors } from "./finding-anchors";
import { checkAnswer, clearCitationChecks } from "./citation-check";
import { buildCitationFeedback, previousAnswerText, MAX_FAILED_CITATIONS } from "./agent-citation-context";

const PATH = "/docs/a.pdf";
const run = (text: string): TextItemRect => ({ text, rect: { x: 72, y: 700, width: 400, height: 12 } });

const ANSWER =
  'Fees accrue daily〔p2 "at three ten-thousandths per day"〕 and the cap is five percent〔p2 "not exceed five percent"〕. ' +
  'Delivery is in 45 days〔p9 "forty-five days"〕.';

function conversation(answer: string) {
  return [
    { role: "user", content: "What are the late fees?" },
    { role: "assistant", content: [{ type: "text", text: answer }] },
    { role: "user", content: [{ type: "text", text: "And the cap?" }] },
  ];
}

beforeEach(() => {
  pages = {};
  clearFindingAnchors();
  clearCitationChecks();
});

describe("buildCitationFeedback", () => {
  it("names the previous answer's citations that were not on their pages", async () => {
    pages[2] = [run("interest at three ten-thousandths per day, capped at five percent in total")];
    await checkAnswer(PATH, 3, ANSWER);
    const note = buildCitationFeedback(PATH, conversation(ANSWER));
    expect(note).toContain("p2 'not exceed five percent' — these words are not on that page");
    expect(note).toContain("p9 'forty-five days' — that page does not exist");
    // The one that checked out is not mentioned.
    expect(note).not.toContain("ten-thousandths");
  });

  it("says nothing about a citation whose check has not come back", () => {
    expect(buildCitationFeedback(PATH, conversation(ANSWER))).toBe("");
  });

  it("says nothing when every citation was found", async () => {
    const answer = 'Fees accrue daily〔p2 "three ten-thousandths per day"〕.';
    pages[2] = [run("interest at three ten-thousandths per day")];
    await checkAnswer(PATH, 3, answer);
    expect(buildCitationFeedback(PATH, conversation(answer))).toBe("");
  });

  it("is bounded", async () => {
    pages[1] = [run("nothing relevant is written on this page at all")];
    const answer = Array.from({ length: 9 }, (_, i) => `Claim ${i}〔p1 "missing words number ${i}"〕.`).join(" ");
    await checkAnswer(PATH, 3, answer);
    const lines = buildCitationFeedback(PATH, conversation(answer)).split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(MAX_FAILED_CITATIONS);
  });

  it("is empty with no document", () => {
    expect(buildCitationFeedback(null, conversation(ANSWER))).toBe("");
  });
});

describe("previousAnswerText", () => {
  it("is the assistant turn between the last two user messages", () => {
    expect(previousAnswerText(conversation("the answer"))).toBe("the answer");
    expect(previousAnswerText([{ role: "user", content: "first question" }])).toBe("");
  });
});
