import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The store the module opens, in memory. `preserveNewer` and the migration
 * chain both go through a real `get`/`set`/`save`, so the plugin is stood in
 * for rather than bypassed.
 */
const h = vi.hoisted(() => ({ data: new Map<string, unknown>() }));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get<T>(key: string): Promise<T | undefined> {
      return h.data.get(key) as T | undefined;
    }
    async set(key: string, value: unknown): Promise<void> {
      h.data.set(key, value);
    }
    async save(): Promise<void> {}
  },
}));

import {
  docChars,
  evictToBudget,
  loadIndexedPages,
  MAX_CACHED_INDEX_DOCS,
  MAX_INDEX_CHARS,
  sanitizeStoredIndex,
  __resetIndexStoreForTests,
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
    // A newer schema is not read as v1. What happens to the blob is
    // `readDocs`' job, not this one's: it is preserved, not dropped — see the
    // downgrade tests below.
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

/**
 * A version this build does not know is preserved, not dropped (20.0).
 *
 * `index-cache.json` holds text the reader paid for one page at a time, and
 * until 20.0 a version it did not recognise was answered with `[]` — and then
 * written back over the file — so one launch of an older build re-bought every
 * page of every scan in it. The store now does what marks and findings have
 * done since 12.0: the blob is kept under `index.newer` until the version that
 * wrote it comes back.
 */
describe("a downgrade does not throw paid pages away", () => {
  const v2 = {
    version: 2,
    docs: [doc("/scan.pdf", 1, 2)],
  };

  beforeEach(() => {
    h.data.clear();
    __resetIndexStoreForTests();
  });

  it("keeps a newer blob under index.newer and reads the store as empty", async () => {
    h.data.set("index", v2);
    expect(await loadIndexedPages("/scan.pdf", "s1")).toEqual([]);
    expect(h.data.get("index.newer")).toEqual(v2);
    // The newer blob is still there too: the read must not replace it.
    expect(h.data.get("index")).toEqual(v2);
  });

  it("never overwrites a blob already stashed by an earlier downgrade", async () => {
    const stashed = { version: 3, docs: [doc("/other.pdf", 1, 1)] };
    h.data.set("index", v2);
    h.data.set("index.newer", stashed);
    await loadIndexedPages("/scan.pdf", "s1");
    expect(h.data.get("index.newer")).toEqual(stashed);
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
