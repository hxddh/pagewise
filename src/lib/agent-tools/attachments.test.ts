import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDocumentTools, newReadBudget, type ReadBudget } from "./index";
import { docCache } from "../doc-cache";
import { addMark, forgetMarks } from "../mark-store";
import type { LoadedDocument } from "../types";

/**
 * What rides along beside the page text, and what it costs.
 *
 * Two things were wrong and they compound. The range reader computed marks and
 * links over its whole range without asking which pages had actually returned
 * text, so a page deduplicated down to a one-line marker still shipped every
 * mark on it — the dedup saved the page and the attachments resent a piece of
 * it. And a mark's text had no cap on this path, though the outline path caps
 * it at 120 characters, even though a mark's text is by definition a passage of
 * the very page being read.
 *
 * These assert the two invariants directly: attachments follow delivery, and a
 * mark is a pointer rather than a second copy.
 */

const PATH = "/tmp/attachments.pdf";
const PAGE_TEXT = (n: number) => `Page ${n}. ${"lorem ipsum ".repeat(60)}`;
const LONG_PASSAGE = "z".repeat(500);

function loadDoc(totalPages = 4): LoadedDocument {
  const doc: LoadedDocument = {
    path: PATH,
    name: "attachments.pdf",
    kind: "pdf",
    totalPages,
    pages: Array.from({ length: totalPages }, (_, i) => ({
      page: i + 1,
      text: PAGE_TEXT(i + 1),
    })),
  };
  docCache.set(doc);
  return doc;
}

type ToolMap = ReturnType<typeof createDocumentTools>;

async function call(tools: ToolMap, name: keyof ToolMap, input: Record<string, unknown>) {
  const tool = tools[name] as unknown as {
    execute: (i: unknown, o: unknown) => Promise<unknown>;
  };
  return (await tool.execute(input, { context: { defaultDocPath: PATH } })) as Record<
    string,
    unknown
  >;
}

type MarkOut = { page: number; text: string; note?: string };

describe("attachments beside a read", () => {
  let budget: ReadBudget;
  let tools: ToolMap;

  beforeEach(() => {
    loadDoc();
    forgetMarks(PATH);
    addMark(PATH, {
      page: 2,
      rects: [{ x: 0, y: 0, width: 10, height: 10 }],
      text: LONG_PASSAGE,
      note: "worth comparing",
      stamp: "",
    });
    budget = newReadBudget();
    tools = createDocumentTools(budget);
  });

  afterEach(() => {
    forgetMarks(PATH);
    docCache.clear();
  });

  it("does not resend a deduplicated page's marks", async () => {
    const first = await call(tools, "read_pdf_range", { start: 1, end: 3, maxChars: 90_000 });
    expect((first.marks as MarkOut[] | undefined)?.length).toBe(1);

    // Second pass: every page comes back as a marker, so nothing is delivered
    // and there is nothing for an attachment to hang on.
    const again = await call(tools, "read_pdf_range", { start: 1, end: 3, maxChars: 90_000 });
    expect(String(again.text)).not.toContain(PAGE_TEXT(2));
    expect(again.marks).toBeUndefined();
  });

  it("still carries marks for the pages a mixed range does deliver", async () => {
    await call(tools, "read_pdf_page", { page: 3 });
    // Page 3 is a marker this time; pages 1-2 are new, and page 2 has the mark.
    const range = await call(tools, "read_pdf_range", { start: 1, end: 3, maxChars: 90_000 });
    expect((range.marks as MarkOut[] | undefined)?.map((m) => m.page)).toEqual([2]);
  });

  it("carries a mark as a pointer, not a second copy of the passage", async () => {
    const read = await call(tools, "read_pdf_page", { page: 2 });
    const mark = (read.marks as MarkOut[])[0]!;
    // The whole passage is already in the page text of this very result.
    expect(mark.text.length).toBeLessThanOrEqual(121);
    expect(String(read.text)).toContain(PAGE_TEXT(2).slice(0, 40));
  });

  it("keeps the reader's own words whole — the note is not the page's text", async () => {
    const read = await call(tools, "read_pdf_page", { page: 2 });
    const mark = (read.marks as MarkOut[])[0]!;
    expect(mark.note).toBe("worth comparing");
  });
});
