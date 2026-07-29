import { describe, expect, it } from "vitest";
import {
  docChars,
  evictToBudget,
  MAX_CACHED_INDEX_DOCS,
  MAX_INDEX_CHARS,
  sanitizeStoredIndex,
} from "./index-store";

function doc(path: string, savedAt: number, pageCount: number, textLen = 100) {
  return {
    path,
    stamp: "s1",
    totalPages: pageCount,
    savedAt,
    pages: Array.from({ length: pageCount }, (_, i) => ({
      page: i + 1,
      text: "x".repeat(textLen),
    })),
  };
}

describe("sanitizeStoredIndex", () => {
  it("returns nothing for a missing, malformed, or foreign-version payload", () => {
    expect(sanitizeStoredIndex(undefined)).toEqual([]);
    expect(sanitizeStoredIndex("nope")).toEqual([]);
    expect(sanitizeStoredIndex({ docs: [doc("/a.pdf", 1, 1)] })).toEqual([]);
    // A newer schema is discarded rather than misread as v1.
    expect(sanitizeStoredIndex({ version: 2, docs: [doc("/a.pdf", 1, 1)] })).toEqual([]);
  });

  it("drops malformed entries instead of throwing on them", () => {
    const result = sanitizeStoredIndex({
      version: 1,
      docs: [
        doc("/good.pdf", 1, 2),
        null,
        { path: "/no-stamp.pdf", totalPages: 1, savedAt: 1, pages: [] },
        { path: 5, stamp: "s", totalPages: 1, savedAt: 1, pages: [] },
      ],
    });
    expect(result.map((d) => d.path)).toEqual(["/good.pdf"]);
  });

  it("keeps the first entry for a duplicated path and drops pages with no text", () => {
    const withEmpty = {
      ...doc("/a.pdf", 1, 2),
      pages: [
        { page: 1, text: "kept" },
        { page: 2, text: "" },
      ],
    };
    const result = sanitizeStoredIndex({
      version: 1,
      docs: [withEmpty, doc("/a.pdf", 2, 5)],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.pages).toEqual([{ page: 1, text: "kept" }]);
  });

  it("drops a document left with no usable pages", () => {
    const empty = { ...doc("/a.pdf", 1, 1), pages: [{ page: 1, text: "" }] };
    expect(sanitizeStoredIndex({ version: 1, docs: [empty] })).toEqual([]);
  });
});

describe("evictToBudget", () => {
  it("keeps the most recently saved documents when over the document cap", () => {
    const docs = Array.from({ length: MAX_CACHED_INDEX_DOCS + 5 }, (_, i) =>
      doc(`/doc-${i}.pdf`, i, 1, 10),
    );
    const kept = evictToBudget(docs);
    expect(kept).toHaveLength(MAX_CACHED_INDEX_DOCS);
    // Highest savedAt survives, lowest is evicted.
    expect(kept.map((d) => d.path)).toContain(`/doc-${MAX_CACHED_INDEX_DOCS + 4}.pdf`);
    expect(kept.map((d) => d.path)).not.toContain("/doc-0.pdf");
  });

  it("never evicts the document that just paid for a page", () => {
    const docs = Array.from({ length: MAX_CACHED_INDEX_DOCS + 1 }, (_, i) =>
      doc(`/doc-${i}.pdf`, i, 1, 10),
    );
    // /doc-0.pdf is the oldest and would normally be the one dropped.
    const kept = evictToBudget(docs, "/doc-0.pdf");
    expect(kept.map((d) => d.path)).toContain("/doc-0.pdf");
  });

  it("drops documents once the character budget is exhausted", () => {
    // Leaves 5 characters of headroom — less than the older document needs.
    const huge = doc("/huge.pdf", 10, 1, MAX_INDEX_CHARS - 5);
    const small = doc("/small.pdf", 5, 1, 10);
    const kept = evictToBudget([huge, small]);
    // The newest fits; the older one no longer does.
    expect(kept.map((d) => d.path)).toEqual(["/huge.pdf"]);
  });

  it("counts characters across every page of a document", () => {
    expect(docChars(doc("/a.pdf", 1, 3, 10))).toBe(30);
  });
});
