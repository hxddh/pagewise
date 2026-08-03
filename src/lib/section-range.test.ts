import { describe, expect, it } from "vitest";
import { findSectionIndex, sectionRange } from "./section-range";
import type { DocHeading } from "./types";

const outline: DocHeading[] = [
  { title: "1 Topologische Grundbegriffe", page: 6, level: 1 },
  { title: "1.1 Topologische Räume", page: 6, level: 2 },
  { title: "1.2 Metrische Räume", page: 10, level: 2 },
  { title: "1.5 Kompaktheit", page: 18, level: 1 },
  { title: "Übungsaufgaben", page: 26, level: 1 },
];

describe("sectionRange", () => {
  it("ends a section on the page before the next heading", () => {
    expect(sectionRange(outline, 2, 117)).toEqual({
      title: "1.2 Metrische Räume",
      startPage: 10,
      endPage: 17,
    });
  });

  it("does not let a subsection end its parent", () => {
    // "1 Topologische Grundbegriffe" runs through its own subsections, to the
    // next level-1 heading.
    expect(sectionRange(outline, 0, 117)?.endPage).toBe(17);
  });

  it("runs the last section to the end of the document", () => {
    expect(sectionRange(outline, 4, 117)?.endPage).toBe(117);
  });

  it("keeps a section on one page when the next heading starts there too", () => {
    // 1.1 starts on the same page as its parent; the range must not invert.
    const range = sectionRange(outline, 1, 117)!;
    expect(range.startPage).toBe(6);
    expect(range.endPage).toBeGreaterThanOrEqual(range.startPage);
  });

  it("refuses a heading that points past the end of the document", () => {
    // Clamping would invent a section over pages it never covered.
    expect(sectionRange(outline, 4, 20)).toBeNull();
  });

  it("clamps a section end to the last page", () => {
    expect(sectionRange(outline, 3, 20)?.endPage).toBe(20);
  });

  it("returns null for an index that is not in the outline", () => {
    expect(sectionRange(outline, -1, 117)).toBeNull();
    expect(sectionRange(outline, 99, 117)).toBeNull();
    expect(sectionRange([], 0, 117)).toBeNull();
  });
});

describe("findSectionIndex", () => {
  it("matches a heading quoted exactly", () => {
    expect(findSectionIndex(outline, "1.2 Metrische Räume")).toBe(2);
  });

  it("matches when the model drops the numeric prefix", () => {
    expect(findSectionIndex(outline, "Metrische Räume")).toBe(2);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(findSectionIndex(outline, "  ÜBUNGSAUFGABEN ")).toBe(4);
  });

  it("prefers the shortest heading that contains the request", () => {
    // "Topologische" appears in both a level-1 and a level-2 heading.
    expect(findSectionIndex(outline, "Topologische Räume")).toBe(1);
  });

  it("reports no match rather than picking something arbitrary", () => {
    expect(findSectionIndex(outline, "Fourieranalyse")).toBe(-1);
    expect(findSectionIndex(outline, "   ")).toBe(-1);
    expect(findSectionIndex([], "anything")).toBe(-1);
  });
});
