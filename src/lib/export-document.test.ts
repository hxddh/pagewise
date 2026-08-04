import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    private data = new Map<string, unknown>();
    async get<T>(key: string): Promise<T | undefined> {
      return this.data.get(key) as T | undefined;
    }
    async set(key: string, value: unknown): Promise<void> {
      this.data.set(key, value);
    }
    async save(): Promise<void> {}
  },
}));

import { documentToMarkdown, emptyExportPages } from "./export-document";
import { addMark, __resetMarkStoreForTests } from "./mark-store";
import type { LoadedDocument } from "./types";

function doc(overrides: Partial<LoadedDocument> = {}): LoadedDocument {
  return {
    path: "/tmp/report.pdf",
    name: "report.pdf",
    kind: "pdf",
    totalPages: 2,
    pages: [
      { page: 1, text: "# 第三季度财务报告\n\n|营业收入|1,284|" },
      { page: 2, text: "## 附注" },
    ],
    ...overrides,
  };
}

describe("documentToMarkdown", () => {
  it("keeps page text as-is and marks page boundaries", () => {
    const md = documentToMarkdown(doc());

    expect(md).toContain("<!-- page 1 -->");
    expect(md).toContain("<!-- page 2 -->");
    // Table structure must survive the export — it is the reason the text is
    // Markdown in the first place.
    expect(md).toContain("|营业收入|1,284|");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("titles the file from PDF metadata, falling back to the file name", () => {
    expect(documentToMarkdown(doc({ title: "Q3 Report" }))).toContain("# Q3 Report");
    expect(documentToMarkdown(doc({ title: "Q3 Report" }))).toContain(
      "**Source:** report.pdf",
    );
    expect(documentToMarkdown(doc())).toContain("# report.pdf");
  });

  it("skips pages with no text instead of emitting empty sections", () => {
    const md = documentToMarkdown(
      doc({ pages: [{ page: 1, text: "text" }, { page: 2, text: "   " }] }),
    );
    expect(md).toContain("<!-- page 1 -->");
    expect(md).not.toContain("<!-- page 2 -->");
  });

  it("orders pages even when the cache holds them out of order", () => {
    const md = documentToMarkdown(
      doc({ pages: [{ page: 2, text: "second" }, { page: 1, text: "first" }] }),
    );
    expect(md.indexOf("first")).toBeLessThan(md.indexOf("second"));
  });
});

describe("emptyExportPages", () => {
  it("reports the pages an export would leave out", () => {
    expect(
      emptyExportPages(doc({ pages: [{ page: 1, text: "a" }, { page: 2, text: "" }] })),
    ).toEqual([2]);
  });
});

describe("documentToMarkdown with marks", () => {
  beforeEach(() => {
    __resetMarkStoreForTests();
  });

  it("carries the reader's marks out with the document", () => {
    // Export is the only way marks leave PageWise — they are deliberately not
    // written back into the PDF.
    const d = doc();
    addMark(d.path, {
      page: 2,
      rects: [{ x: 1, y: 2, width: 3, height: 4 }],
      text: "营业收入 1,284",
      note: "对不上第 1 页",
      stamp: "s1",
    });
    const md = documentToMarkdown(d);
    expect(md).toContain("## Marks");
    expect(md).toContain("**p. 2** — 营业收入 1,284");
    expect(md).toContain("对不上第 1 页");
  });

  it("omits the section entirely when nothing was marked", () => {
    expect(documentToMarkdown(doc())).not.toContain("## Marks");
  });
});
