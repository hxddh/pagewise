import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDocumentTools, newReadBudget, type ReadBudget } from "./agent";
import { docCache } from "./doc-cache";
import type { LoadedDocument } from "./types";

/**
 * A page handed to the model twice in one turn is billed twice.
 *
 * 7.2 added a set of pages already returned, but read and wrote it only inside
 * the range reader — so the single-page tool, the most-called of the six,
 * neither consulted nor updated it. Three of the four orderings below still
 * paid for a second full copy, including the one the change was written for.
 *
 * These tests are the ones that were missing: they ask the question per pair of
 * tools rather than per implementation, so a future reader that grows its own
 * code path cannot quietly fall out of the guarantee.
 */

const PATH = "/tmp/dedup.pdf";
/** Longer than the smallest maxChars used below, so truncation is reachable. */
const PAGE_TEXT = (n: number) => `Page ${n} body. ${"lorem ipsum ".repeat(400)}`;

function loadDoc(totalPages = 6): LoadedDocument {
  const doc: LoadedDocument = {
    path: PATH,
    name: "dedup.pdf",
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

/** Invoke a tool the way the loop does, with the active document in context. */
async function call(tools: ToolMap, name: keyof ToolMap, input: Record<string, unknown>) {
  const tool = tools[name] as unknown as {
    execute: (i: unknown, o: unknown) => Promise<unknown>;
  };
  return (await tool.execute(input, { context: { defaultDocPath: PATH } })) as Record<
    string,
    unknown
  >;
}

/** The marker a repeat comes back as, instead of the page text. */
function isMarker(text: string, page: number): boolean {
  return text.includes(`Page ${page}`) && !text.includes(PAGE_TEXT(page));
}

describe("a page is handed over once per turn", () => {
  let budget: ReadBudget;
  let tools: ToolMap;

  beforeEach(() => {
    loadDoc();
    budget = newReadBudget();
    tools = createDocumentTools(budget);
  });

  afterEach(() => {
    docCache.clear();
  });

  it("range then range — the second copy is a marker", async () => {
    await call(tools, "read_pdf_range", { start: 1, end: 3, maxChars: 50_000 });
    const again = await call(tools, "read_pdf_range", { start: 2, end: 3, maxChars: 50_000 });
    expect(isMarker(String(again.text), 2)).toBe(true);
  });

  it("range then page — the ordering the dedup was written for", async () => {
    await call(tools, "read_pdf_range", { start: 1, end: 4, maxChars: 50_000 });
    const again = await call(tools, "read_pdf_page", { page: 3 });
    expect(String(again.text)).not.toContain(PAGE_TEXT(3));
  });

  it("page then range — a page read alone still counts as delivered", async () => {
    await call(tools, "read_pdf_page", { page: 2 });
    const range = await call(tools, "read_pdf_range", { start: 1, end: 3, maxChars: 50_000 });
    // Page 1 and 3 are new and come back whole; page 2 does not repeat.
    expect(String(range.text)).toContain(PAGE_TEXT(1));
    expect(isMarker(String(range.text), 2)).toBe(true);
  });

  it("page then page — the same page twice", async () => {
    await call(tools, "read_pdf_page", { page: 5 });
    const again = await call(tools, "read_pdf_page", { page: 5 });
    expect(String(again.text)).not.toContain(PAGE_TEXT(5));
  });

  it("a page cut short can still be continued", async () => {
    // A truncated read is not a full delivery: the model must be able to ask
    // for the rest, or a long page becomes unreadable past its first slice.
    const first = await call(tools, "read_pdf_page", { page: 1, maxChars: 2000 });
    expect(first.truncated).toBe(true);
    const rest = await call(tools, "read_pdf_page", {
      page: 1,
      offset: first.nextOffset as number,
      maxChars: 2000,
    });
    expect(String(rest.text).length).toBeGreaterThan(0);
  });

  it("a new turn starts over — the reader may ask the same question twice", async () => {
    await call(tools, "read_pdf_page", { page: 4 });
    budget.delivered.clear();
    const again = await call(tools, "read_pdf_page", { page: 4 });
    expect(String(again.text)).toContain(PAGE_TEXT(4));
  });
});
