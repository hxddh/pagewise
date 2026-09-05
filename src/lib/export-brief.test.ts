import { describe, expect, it } from "vitest";
import { briefToMarkdown, BRIEF_LABELS_ZH, pageRef, type BriefEntry } from "./export-brief";
import type { Finding } from "./finding-store";
import type { LoadedDocument } from "./types";

const doc = (over: Partial<LoadedDocument> = {}): LoadedDocument => ({
  path: "/tmp/report.pdf",
  name: "report.pdf",
  kind: "pdf",
  totalPages: 3,
  stamp: "1700000000.000000000:4096",
  pages: [],
  ...over,
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: over.id ?? "f1",
  pages: [2],
  claim: "The trial ran eight weeks.",
  evidence: "…ran for eight weeks…",
  createdAt: 1,
  stamp: "s",
  ...over,
});

/**
 * The one export that does not need the chat to be understood.
 *
 * Acceptance 7 of the 12.0 design: read only the file and say, for each
 * conclusion, which page it is on and which entries still need checking.
 */
describe("briefToMarkdown", () => {
  it("files each entry by trust, with its page, and numbers them once", () => {
    const entries: BriefEntry[] = [
      { finding: finding({ id: "a", claim: "Checked." }), trust: "confirmed" },
      { finding: finding({ id: "b", claim: "Found.", pages: [3] }), trust: "located" },
      { finding: finding({ id: "c", claim: "Changed under." }), trust: "stale" },
      { finding: finding({ id: "d", claim: "Struck." }), trust: "retracted" },
    ];
    const md = briefToMarkdown(doc(), entries, undefined, new Date(0));

    expect(md).toContain("# report.pdf — Brief");
    expect(md).toContain("**Document:** report.pdf · 3 pages · 1700000000.000000000:4096");
    const conclusions = md.slice(md.indexOf("## Conclusions"), md.indexOf("## Evidence"));
    expect(conclusions).toContain("1. Checked. — p. 2 · _checked by the reader_");
    expect(conclusions).toContain("2. Found. — p. 3 · _wording found on the page_");
    expect(conclusions).not.toContain("Changed under.");
    const evidence = md.slice(md.indexOf("## Evidence"), md.indexOf("## To re-check"));
    expect(evidence).toContain("**1.** p. 2");
    expect(evidence).toContain("> …ran for eight weeks…");
    const recheck = md.slice(md.indexOf("## To re-check"));
    expect(recheck).toContain("3. Changed under. — p. 2 · _file changed since this was written_");
    // A retracted entry is not in the brief at all.
    expect(md).not.toContain("Struck.");
  });

  it("lists an unverified entry to re-check, never as a conclusion", () => {
    const md = briefToMarkdown(
      doc(),
      [{ finding: finding({ evidence: "" }), trust: "unverified" }],
      undefined,
      new Date(0),
    );
    expect(md.slice(md.indexOf("## Conclusions"), md.indexOf("## Evidence"))).toContain(
      "Nothing yet.",
    );
    expect(md.slice(md.indexOf("## To re-check"))).toContain("_nothing to check against_");
  });

  it("carries the whole kept answer under its conclusion, indented", () => {
    const body = "| week | n |\n|---|---|\n| 8 | 40 |\n\nEight weeks, **unless** the site closed.";
    const md = briefToMarkdown(
      doc(),
      [{ finding: finding({ body, author: "reader" }), trust: "confirmed" }],
      undefined,
      new Date(0),
    );
    expect(md).toContain("   _Kept from an answer:_");
    expect(md).toContain("   | week | n |");
    expect(md).toContain("   Eight weeks, **unless** the site closed.");
  });

  it("names pages by their printed number, with the sheet behind it", () => {
    const labelled = doc({ totalPages: 4, pageLabels: ["i", "ii", "1", "2"] });
    expect(pageRef(labelled, 2)).toBe("ii (sheet 2)");
    expect(pageRef(labelled, 3)).toBe("1 (sheet 3)");
    expect(pageRef(doc(), 3)).toBe("3");
    const md = briefToMarkdown(
      labelled,
      [{ finding: finding({ pages: [2, 4] }), trust: "located" }],
      undefined,
      new Date(0),
    );
    expect(md).toContain("p. ii (sheet 2), 2 (sheet 4)");
  });

  it("reads in the reader's language", () => {
    const md = briefToMarkdown(
      doc(),
      [{ finding: finding(), trust: "located" }],
      BRIEF_LABELS_ZH,
      new Date(0),
    );
    expect(md).toContain("## 结论");
    expect(md).toContain("第 2 页 · _原文已在页面上找到_");
    expect(md).toContain("## 待复核");
  });
});
