import { describe, expect, it, vi } from "vitest";
import type { Mark } from "../../lib/mark-store";
import type { Finding } from "../../lib/finding-store";
import type { AnswerNote, PageCitation } from "../../lib/page-citations";

const marks: Mark[] = [
  { id: "m1", page: 2, rects: [], text: "first", note: "", createdAt: 1, stamp: "s" },
  { id: "m2", page: 2, rects: [], text: "", note: "the figure", createdAt: 2, stamp: "s", kind: "region" },
  { id: "m3", page: 5, rects: [], text: "elsewhere", note: "", createdAt: 3, stamp: "s" },
];

const finding = (id: string, page: number, extra: Partial<Finding> = {}): Finding => ({
  id,
  pages: [page],
  claim: `claim ${id}`,
  evidence: "",
  createdAt: 1,
  stamp: "s",
  ...extra,
});

const findings: Finding[] = [
  finding("f1", 2),
  finding("f2", 2, { struck: true }),
  finding("f3", 2, { supersedes: undefined }),
  finding("f4", 2),
  finding("f5", 9),
];
// f4 supersedes f3: the earlier claim no longer stands, so only f4 is drawn.
findings[3]!.supersedes = "f3";

const citations = new Map<number, PageCitation[]>([
  [2, [{ messageId: "a1", page: 2, quote: "quoted words" }]],
]);

vi.mock("../../lib/mark-store", () => ({
  getMarks: (path: string) => (path === "/doc.pdf" ? marks : []),
}));
vi.mock("../../lib/finding-store", () => ({
  getFindings: (path: string) => (path === "/doc.pdf" ? findings : []),
  findingsOnPage: (path: string, page: number) =>
    path === "/doc.pdf" ? findings.filter((f) => f.pages.includes(page)) : [],
  isSuperseded: (all: readonly Finding[], id: string) => all.some((f) => f.supersedes === id),
}));

const { gutterEntries, columnEntries, columnTops, cardExcerpt, MAX_MARGIN_ENTRIES, COLUMN_MIN_STEP, MAX_CARD_EXCERPT } =
  await import("./page-gutter");

describe("gutterEntries", () => {
  it("lists marks, then findings, then answers — for this page only", () => {
    const entries = gutterEntries("/doc.pdf", 2, citations);
    expect(entries.map((e) => `${e.kind}:${e.id}`)).toEqual([
      "mark:m1",
      "mark:m2",
      "finding:f1",
      "finding:f4",
      "answer:a1",
    ]);
  });

  it("drops struck and superseded findings, as the page does", () => {
    const ids = gutterEntries("/doc.pdf", 2, citations).map((e) => e.id);
    expect(ids).not.toContain("f2"); // struck
    expect(ids).not.toContain("f3"); // replaced by f4
  });

  it("gives each entry the note a hover shows", () => {
    const entries = gutterEntries("/doc.pdf", 2, citations);
    expect(entries.find((e) => e.id === "m1")?.note).toBe("first");
    expect(entries.find((e) => e.id === "m2")?.note).toBe("the figure");
    expect(entries.find((e) => e.id === "f1")?.note).toBe("claim f1");
    expect(entries.find((e) => e.id === "a1")?.note).toBe("quoted words");
  });

  it("draws nothing for a page with nothing on it", () => {
    expect(gutterEntries("/doc.pdf", 7, citations)).toEqual([]);
    // Marks and findings are scoped by path; the citations map is already the
    // open document's own conversation, so it is the page that scopes it.
    expect(gutterEntries("/other.pdf", 2, citations).map((e) => e.kind)).toEqual(["answer"]);
  });

  it("caps each kind so the strip cannot run past the page", () => {
    const many = new Map<number, PageCitation[]>();
    many.set(
      2,
      Array.from({ length: MAX_MARGIN_ENTRIES + 5 }, (_, i) => ({
        messageId: `a${i}`,
        page: 2,
        quote: null,
      })),
    );
    const answers = gutterEntries("/doc.pdf", 2, many).filter((e) => e.kind === "answer");
    expect(answers).toHaveLength(MAX_MARGIN_ENTRIES);
  });
});

/**
 * The margin column (20.0): the entries' words, and the rule that decides who
 * stays in the column and who is only in the record panel.
 */
describe("columnEntries", () => {
  const notes = new Map<number, AnswerNote[]>([
    [
      2,
      [
        {
          messageId: "a1",
          page: 2,
          text: "The opening line is a specimen.",
          state: "verified",
          reason: "located",
          citations: [{ pages: [2], quote: "Lorem ipsum", raw: '〔p2 "Lorem ipsum"〕', index: 0 }],
        },
        {
          messageId: "a1",
          page: 2,
          text: "Nothing says where this sentence came from.",
          state: "unchecked",
          reason: "noMarker",
          citations: [],
        },
      ],
    ],
  ]);

  it("draws one entry per sentence that cites the page, with its state", () => {
    const entries = columnEntries("/doc.pdf", 2, notes).filter((e) => e.kind === "answer");
    expect(entries.map((e) => e.text)).toEqual([
      "The opening line is a specimen.",
      "Nothing says where this sentence came from.",
    ]);
    expect(entries.map((e) => e.state)).toEqual(["verified", "unchecked"]);
    expect(entries.map((e) => e.reason)).toEqual(["located", "noMarker"]);
  });

  it("carries the words for the marks and findings too", () => {
    const entries = columnEntries("/doc.pdf", 2, notes);
    expect(entries.map((e) => `${e.kind}:${e.text}`)).toEqual([
      "mark:first",
      "mark:the figure",
      "finding:claim f1",
      "finding:claim f4",
      "answer:The opening line is a specimen.",
      "answer:Nothing says where this sentence came from.",
    ]);
  });

  it("leaves struck and superseded findings to the record, as the dots do", () => {
    const ids = columnEntries("/doc.pdf", 2, notes).map((e) => e.id);
    expect(ids).not.toContain("f2");
    expect(ids).not.toContain("f3");
  });

  it("caps each kind so the column cannot run past the page", () => {
    const many = new Map<number, AnswerNote[]>();
    many.set(
      2,
      Array.from({ length: MAX_MARGIN_ENTRIES + 5 }, (_, i) => ({
        messageId: `a${i}`,
        page: 2,
        text: `sentence ${i}`,
        state: "unchecked" as const,
        reason: "noMarker" as const,
        citations: [],
      })),
    );
    const answers = columnEntries("/doc.pdf", 2, many).filter((e) => e.kind === "answer");
    expect(answers).toHaveLength(MAX_MARGIN_ENTRIES);
  });
});

describe("columnTops", () => {
  it("keeps each entry at the passage it is about", () => {
    expect(columnTops([0.1, 0.5, 0.9])).toEqual([0.1, 0.5, 0.9]);
  });

  it("pushes an entry down rather than drawing it over the one before it", () => {
    const tops = columnTops([0.2, 0.21, 0.22]);
    expect(tops[0]).toBe(0.2);
    expect(tops[1]).toBeCloseTo(0.2 + COLUMN_MIN_STEP);
    expect(tops[2]).toBeCloseTo(0.2 + COLUMN_MIN_STEP * 2);
  });

  it("orders the pushes by position, not by the caller's order", () => {
    // The second entry is the higher one; it must not be pushed below the
    // first just because the caller listed it second.
    const tops = columnTops([0.3, 0.31, 0.05]);
    expect(tops[2]).toBe(0.05);
    expect(tops[0]).toBe(0.3);
    expect(tops[1]).toBeCloseTo(0.3 + COLUMN_MIN_STEP);
  });

  it("starts an entry with no anchor at the top of the page", () => {
    // A quote that was not found, a check still running: nothing to anchor to,
    // and the page's own top is still beside the page it is about.
    expect(columnTops([undefined, 0.5])).toEqual([0, 0.5]);
  });
});

/**
 * The card's excerpt (20.0): the passage as much of it as the card holds, cut
 * at a word boundary and marked with an ellipsis, so a reader can see the
 * passage goes on and never reads a word with its end missing.
 */
describe("cardExcerpt", () => {
  it("leaves a passage the card can hold alone", () => {
    const text = "Page 1 is filler text, not an argument.";
    expect(cardExcerpt(text)).toBe(text);
  });

  it("cuts a long passage at a word boundary, with an ellipsis", () => {
    const text =
      "Lorem ipsum dolor sit amet, consetetur sadipscing elitr, sed diam nonumy eirmod tempor invidunt ut labore on page 1.";
    const out = cardExcerpt(text);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_CARD_EXCERPT + 1);
    // The passage's own beginning, and the cut lands on a space: the card
    // never ends mid-word.
    const body = out.slice(0, -1);
    expect(text.startsWith(body)).toBe(true);
    expect(text[body.length]).toBe(" ");
  });

  it("cuts a passage with no spaces at the cap rather than hanging", () => {
    const text = "x".repeat(MAX_CARD_EXCERPT + 10);
    expect(cardExcerpt(text)).toBe(`${"x".repeat(MAX_CARD_EXCERPT)}…`);
  });
});
