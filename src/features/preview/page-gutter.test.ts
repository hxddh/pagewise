import { describe, expect, it, vi } from "vitest";
import type { Mark } from "../../lib/mark-store";
import type { Finding } from "../../lib/finding-store";
import type { PageCitation } from "../../lib/page-citations";

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

const { gutterEntries, MAX_GUTTER_DOTS } = await import("./page-gutter");

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
      Array.from({ length: MAX_GUTTER_DOTS + 5 }, (_, i) => ({
        messageId: `a${i}`,
        page: 2,
        quote: null,
      })),
    );
    const answers = gutterEntries("/doc.pdf", 2, many).filter((e) => e.kind === "answer");
    expect(answers).toHaveLength(MAX_GUTTER_DOTS);
  });
});
