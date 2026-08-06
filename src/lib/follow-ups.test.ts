import { describe, expect, it } from "vitest";
import { followUpSuggestions } from "./follow-ups";
import type { DocHeading } from "./types";

const t = (k: string, v?: Record<string, string | number>) =>
  v ? `${k}:${Object.values(v).join(",")}` : k;

const outline: DocHeading[] = [
  { title: "One", page: 1, level: 1 },
  { title: "Two", page: 10, level: 1 },
  { title: "Three", page: 30, level: 1 },
];

const base = { readPages: [], outline, totalPages: 100, unindexedCount: 0, markCount: 0, t };

describe("followUpSuggestions", () => {
  it("points at the section after the pages this reply read", () => {
    const out = followUpSuggestions({ ...base, readPages: [10, 11, 12] });
    expect(out[0]!.kind).toBe("nextSection");
    expect(out[0]!.section).toBe("Three");
  });

  it("does not point back at the section it just read", () => {
    const out = followUpSuggestions({ ...base, readPages: [31, 32] });
    expect(out.some((f) => f.kind === "nextSection")).toBe(false);
  });

  it("offers a scan only when pages are actually unreadable, and says how many", () => {
    expect(followUpSuggestions(base).some((f) => f.kind === "scanUnindexed")).toBe(false);
    const out = followUpSuggestions({ ...base, unindexedCount: 12 });
    const scan = out.find((f) => f.kind === "scanUnindexed")!;
    expect(scan.count).toBe(12);
    expect(scan.text).toContain("12");
  });

  it("offers the marks only when there are marks", () => {
    expect(followUpSuggestions(base).some((f) => f.kind === "compareMarks")).toBe(false);
    expect(
      followUpSuggestions({ ...base, markCount: 3 }).some((f) => f.kind === "compareMarks"),
    ).toBe(true);
  });

  it("offers the whole document only when this reply saw a corner of it", () => {
    const small = followUpSuggestions({ ...base, readPages: [1, 2] });
    expect(small.some((f) => f.kind === "wholeDocument")).toBe(true);

    const most = followUpSuggestions({
      ...base,
      totalPages: 4,
      readPages: [1, 2, 3],
    });
    expect(most.some((f) => f.kind === "wholeDocument")).toBe(false);
  });

  it("never offers more than three", () => {
    const out = followUpSuggestions({
      ...base,
      readPages: [1],
      unindexedCount: 5,
      markCount: 2,
    });
    expect(out).toHaveLength(3);
  });

  it("says nothing when there is nothing worth asking", () => {
    // A one-page document, fully read, nothing marked, nothing unreadable.
    const out = followUpSuggestions({
      ...base,
      outline: [],
      totalPages: 1,
      readPages: [1],
    });
    expect(out).toEqual([]);
  });
});
