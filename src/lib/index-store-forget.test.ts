import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a re-index is allowed to delete from the persisted page cache.
 *
 * That cache exists for one reason: vision pages cost money, so a page that was
 * paid for once should not be paid for again on the next open. A re-index
 * rescans a bounded window — deliberately, so the text it discards is text it
 * will pay to replace — and then called `forgetIndexedDoc`, which deleted the
 * persisted copy of *every* page in the document.
 *
 * The pages outside that window keep their text in memory, so nothing looked
 * wrong for the rest of the session. They just had nothing on disk any more,
 * and were re-scanned and re-billed the next time the document was opened. On a
 * 200-page scan with the default 50-page window, changing the vision model
 * silently threw away 150 pages of paid work.
 */

const h = vi.hoisted(() => ({ saved: undefined as unknown }));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return h.saved;
    }
    async set(_key: string, value: unknown) {
      h.saved = value;
    }
    async save() {}
  },
}));

const { __resetIndexStoreForTests, forgetIndexedPages, loadIndexedPages } = await import(
  "./index-store"
);

const STAMP = "stamp-1";
const PATH = "/docs/scan.pdf";
const body = (n: number) => `page ${n} ${"x".repeat(60)}`;

function seed(pageCount: number): void {
  h.saved = {
    version: 1,
    docs: [
      {
        path: PATH,
        stamp: STAMP,
        totalPages: pageCount,
        savedAt: 1,
        pages: Array.from({ length: pageCount }, (_, i) => ({
          page: i + 1,
          text: body(i + 1),
        })),
      },
      {
        path: "/docs/other.pdf",
        stamp: STAMP,
        totalPages: 1,
        savedAt: 1,
        pages: [{ page: 1, text: body(1) }],
      },
    ],
  };
}

const persistedPages = async (path = PATH) =>
  (await loadIndexedPages(path, STAMP)).map((p) => p.page);

beforeEach(() => {
  __resetIndexStoreForTests();
  seed(200);
});

describe("forgetIndexedPages", () => {
  it("keeps the pages a re-index will not rescan", async () => {
    const rescanned = Array.from({ length: 50 }, (_, i) => i + 1);
    await forgetIndexedPages(PATH, rescanned);

    const left = await persistedPages();
    expect(left).not.toContain(1);
    expect(left).not.toContain(50);
    // The 150 pages nobody is going to look at again keep what they cost.
    expect(left).toHaveLength(150);
    expect(left[0]).toBe(51);
    expect(left[left.length - 1]).toBe(200);
  });

  it("leaves the surviving pages' text untouched", async () => {
    await forgetIndexedPages(PATH, [1, 2, 3]);
    const pages = await loadIndexedPages(PATH, STAMP);
    expect(pages.find((p) => p.page === 4)?.text).toBe(body(4));
  });

  it("drops the document when nothing is left", async () => {
    seed(3);
    await forgetIndexedPages(PATH, [1, 2, 3]);
    expect(await persistedPages()).toEqual([]);
  });

  it("does not touch any other document", async () => {
    await forgetIndexedPages(PATH, [1, 2, 3]);
    expect(await persistedPages("/docs/other.pdf")).toEqual([1]);
  });

  it("ignores pages the document does not have", async () => {
    seed(3);
    await forgetIndexedPages(PATH, [7, 8]);
    expect(await persistedPages()).toEqual([1, 2, 3]);
  });

  it("does nothing for an empty page list", async () => {
    seed(3);
    await forgetIndexedPages(PATH, []);
    expect(await persistedPages()).toEqual([1, 2, 3]);
  });

  it("does not throw for a document that was never cached", async () => {
    await expect(forgetIndexedPages("/docs/missing.pdf", [1])).resolves.toBeUndefined();
    expect(await persistedPages()).toHaveLength(200);
  });
});
