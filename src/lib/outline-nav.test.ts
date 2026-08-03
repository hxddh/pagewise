import { describe, expect, it } from "vitest";
import { activeHeadingIndex, usableOutline } from "./outline-nav";
import type { DocHeading } from "./types";

const outline: DocHeading[] = [
  { title: "1 Topologische Grundbegriffe", page: 6, level: 1 },
  { title: "1.2 Metrische Räume", page: 10, level: 1 },
  { title: "1.3 Stetigkeit", page: 13, level: 1 },
];

describe("activeHeadingIndex", () => {
  it("marks the section the page falls inside, not the next one", () => {
    expect(activeHeadingIndex(outline, 6)).toBe(0);
    expect(activeHeadingIndex(outline, 9)).toBe(0);
    expect(activeHeadingIndex(outline, 10)).toBe(1);
    expect(activeHeadingIndex(outline, 12)).toBe(1);
  });

  it("keeps the last section active through the end of the document", () => {
    expect(activeHeadingIndex(outline, 13)).toBe(2);
    expect(activeHeadingIndex(outline, 117)).toBe(2);
  });

  it("marks nothing active on a cover page that precedes every heading", () => {
    expect(activeHeadingIndex(outline, 1)).toBe(-1);
    expect(activeHeadingIndex(outline, 5)).toBe(-1);
  });

  it("has no active entry when there is no outline", () => {
    expect(activeHeadingIndex([], 3)).toBe(-1);
  });
});

describe("usableOutline", () => {
  it("drops entries that would render as an empty row", () => {
    const messy: DocHeading[] = [
      { title: "Vorwort", page: 2, level: 1 },
      { title: "   ", page: 3, level: 1 },
    ];
    expect(usableOutline(messy, 10).map((h) => h.title)).toEqual(["Vorwort"]);
  });

  it("drops entries pointing outside the document", () => {
    const messy: DocHeading[] = [
      { title: "Real", page: 4, level: 1 },
      { title: "Past the end", page: 999, level: 1 },
      { title: "Before the start", page: 0, level: 1 },
      { title: "Fractional", page: 2.5, level: 1 },
    ];
    expect(usableOutline(messy, 10).map((h) => h.title)).toEqual(["Real"]);
  });

  it("keeps every entry when the page count is unknown", () => {
    const headings: DocHeading[] = [{ title: "Real", page: 400, level: 1 }];
    expect(usableOutline(headings, 0)).toHaveLength(1);
  });

  it("treats a document with no outline as empty rather than throwing", () => {
    expect(usableOutline(undefined, 10)).toEqual([]);
  });
});
