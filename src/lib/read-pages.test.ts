import { describe, expect, it } from "vitest";
import { collectReadPages } from "./read-pages";

// Build a tool UI part matching the AI SDK shape isToolUIPart recognizes.
function toolPart(name: string, input: Record<string, unknown>, state = "output-available") {
  return { type: `tool-${name}`, toolCallId: `${name}-${Math.random()}`, state, input } as never;
}

describe("collectReadPages", () => {
  it("collects single page reads", () => {
    const parts = [toolPart("read_pdf_page", { page: 5 }), toolPart("read_pdf_page", { page: 2 })];
    expect(collectReadPages(parts)).toEqual([2, 5]);
  });

  it("expands a page range", () => {
    expect(collectReadPages([toolPart("read_pdf_range", { start: 3, end: 6 })])).toEqual([3, 4, 5, 6]);
  });

  it("dedupes across tools and sorts", () => {
    const parts = [
      toolPart("read_pdf_range", { start: 4, end: 5 }),
      toolPart("read_pdf_page", { page: 4 }),
      toolPart("read_pdf_page", { page: 1 }),
    ];
    expect(collectReadPages(parts)).toEqual([1, 4, 5]);
  });

  it("treats a range with no/invalid end as a single page", () => {
    expect(collectReadPages([toolPart("read_pdf_range", { start: 7 })])).toEqual([7]);
  });

  it("ignores non-read tools and non-numeric input", () => {
    const parts = [
      toolPart("search_in_document", { query: "x" }),
      toolPart("document_outline", {}),
      toolPart("read_pdf_page", { page: "3" }),
    ];
    expect(collectReadPages(parts)).toEqual([]);
  });

  it("ignores tool calls that haven't produced input yet", () => {
    expect(collectReadPages([toolPart("read_pdf_page", { page: 9 }, "input-streaming")])).toEqual([]);
  });

  it("returns empty for missing/empty parts", () => {
    expect(collectReadPages(undefined)).toEqual([]);
    expect(collectReadPages([])).toEqual([]);
  });
});
