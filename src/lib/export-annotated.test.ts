import { describe, expect, it } from "vitest";
import { findingAnnotations, markAnnotations, type AnnotationLabels } from "./export-annotated";
import type { FindingPlacement } from "./finding-anchors";
import type { Finding } from "./finding-store";
import type { Mark } from "./mark-store";

const labels: AnnotationLabels = {
  assistant: "PageWise",
  reader: "Reader",
  finding: "Finding",
  mark: "Mark",
  foundOnPage: (p) => `Wording found on page ${p}`,
  confirmed: "Checked by the reader",
};

const finding = (id: string, extra: Partial<Finding> = {}): Finding => ({
  id,
  pages: [3],
  claim: `claim ${id}`,
  evidence: "the words",
  createdAt: 0,
  stamp: "s",
  ...extra,
});

const located: FindingPlacement = {
  status: "located",
  anchor: { page: 3, rects: [{ x: 72, y: 600, width: 100, height: 12 }], bounds: { x: 72, y: 600, width: 100, height: 12 } },
};

describe("findingAnnotations", () => {
  it("writes only findings whose wording is on the page", () => {
    const placements = new Map<string, FindingPlacement>([
      ["a", located],
      ["b", { status: "absent" }],
      ["c", located],
      ["d", { status: "unconfirmed" }],
    ]);
    const out = findingAnnotations(
      [
        { finding: finding("a"), trust: "located" },
        { finding: finding("b"), trust: "unlocated" },
        { finding: finding("c", { author: "reader" }), trust: "confirmed" },
        { finding: finding("d"), trust: "unconfirmed" },
      ],
      placements,
      labels,
    );
    expect(out.map((a) => a.id)).toEqual(["f-a", "f-c"]);
    expect(out[0]).toMatchObject({ page: 3, frame: "pdf", kind: "highlight", author: "PageWise" });
    expect(out[0]!.contents).toBe("claim a\n\nWording found on page 3");
    expect(out[1]).toMatchObject({ author: "Reader", contents: "claim c\n\nChecked by the reader" });
  });

  it("B16: writes a confirmed finding whose number the check doubted (16.0)", () => {
    const placements = new Map<string, FindingPlacement>([
      ["m", { status: "mismatch", anchor: located.status === "located" ? located.anchor : (null as never), unstated: ["30%"] }],
      ["n", { status: "mismatch", anchor: located.status === "located" ? located.anchor : (null as never), unstated: ["30%"] }],
    ]);
    const out = findingAnnotations(
      [
        { finding: finding("m", { author: "reader" }), trust: "confirmed" },
        { finding: finding("n"), trust: "mismatch" as never },
      ],
      placements,
      labels,
    );
    expect(out.map((a) => a.id)).toEqual(["f-m"]);
  });

  it("does not write a confirmed finding it cannot place", () => {
    const out = findingAnnotations([{ finding: finding("x"), trust: "confirmed" }], new Map(), labels);
    expect(out).toEqual([]);
  });
});

describe("markAnnotations", () => {
  const mark = (id: string, extra: Partial<Mark> = {}): Mark => ({
    id,
    page: 2,
    rects: [{ x: 10, y: 10, width: 50, height: 12 }],
    text: "words",
    note: "",
    createdAt: 0,
    stamp: "now",
    ...extra,
  });

  it("outlines regions, highlights words, and carries the note", () => {
    const out = markAnnotations([mark("t", { note: "check this" }), mark("r", { kind: "region" })], "now", labels);
    expect(out.map((a) => [a.id, a.kind, a.frame, a.contents])).toEqual([
      ["m-t", "highlight", "view", "check this"],
      ["m-r", "square", "view", ""],
    ]);
  });

  it("leaves out marks made on an earlier version of the file", () => {
    const out = markAnnotations([mark("old", { stamp: "before" }), mark("new")], "now", labels);
    expect(out.map((a) => a.id)).toEqual(["m-new"]);
  });
});
