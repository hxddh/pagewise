import { afterEach, describe, expect, it } from "vitest";
import { docCache } from "./doc-cache";
import type { LoadedDocument } from "./types";

/**
 * Which page text a re-index is allowed to throw away.
 *
 * `reindexDocument` runs when the reader changes their vision model, and it
 * clears page text so the new model can look at those pages again. But it
 * cleared *every* page it was given, and it is given every page in the
 * document — including pages whose text came out of the PDF's own text layer,
 * which no vision model produced and none can improve.
 *
 * That text is free: it is re-extracted on every open. Clearing it turns those
 * pages into pages with no usable text, and a page with no usable text is
 * exactly what the indexer sends to vision — so changing the vision model
 * billed a scan for every text page in the document.
 *
 * `PageText.source` exists to tell the two apart. Its own comment says so:
 * "Vision text was paid for per page; native text is free to recompute on
 * every open."
 */

const PATH = "/tmp/reindex.pdf";

function load(pages: LoadedDocument["pages"]): void {
  docCache.set({
    path: PATH,
    name: "reindex.pdf",
    kind: "pdf",
    totalPages: pages.length,
    pages,
  });
}

const textOf = (page: number) =>
  docCache.getPages(PATH).find((p) => p.page === page)?.text ?? "";

afterEach(() => docCache.clear());

describe("invalidateIndexedPageText", () => {
  it("drops what a vision call produced", () => {
    load([{ page: 1, text: "scanned by the old model", source: "vision" }]);
    docCache.invalidateIndexedPageText(PATH, [1]);
    expect(textOf(1)).toBe("");
  });

  it("keeps text the PDF itself provided", () => {
    // Changing the vision model has nothing to say about a page that already
    // has a text layer. Clearing it makes the page look unindexed, and the
    // indexer pays for a scan of a page that never needed one.
    load([{ page: 1, text: "a page with a real text layer", source: "native" }]);
    docCache.invalidateIndexedPageText(PATH, [1]);
    expect(textOf(1)).toBe("a page with a real text layer");
  });

  it("clears only the vision pages of a mixed document", () => {
    load([
      { page: 1, text: "native text", source: "native" },
      { page: 2, text: "vision text", source: "vision" },
      { page: 3, text: "more native text", source: "native" },
    ]);
    docCache.invalidateIndexedPageText(PATH, [1, 2, 3]);
    expect([textOf(1), textOf(2), textOf(3)]).toEqual([
      "native text",
      "",
      "more native text",
    ]);
  });

  it("leaves pages outside the requested set alone", () => {
    load([
      { page: 1, text: "vision one", source: "vision" },
      { page: 2, text: "vision two", source: "vision" },
    ]);
    docCache.invalidateIndexedPageText(PATH, [1]);
    expect(textOf(2)).toBe("vision two");
  });

  it("does nothing to a document it does not hold", () => {
    load([{ page: 1, text: "x", source: "vision" }]);
    expect(() => docCache.invalidateIndexedPageText("/tmp/other.pdf", [1])).not.toThrow();
    expect(textOf(1)).toBe("x");
  });
});
