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

import {
  addMark,
  getMarks,
  MAX_MARK_TEXT,
  MAX_MARKS_PER_DOC,
  MAX_NOTE_TEXT,
  marksAreStale,
  marksOnPage,
  pagesWithMarks,
  removeMark,
  sanitizeStoredMarks,
  setMarkNote,
  subscribeMarks,
  __resetMarkStoreForTests,
} from "./mark-store";

const PATH = "/docs/contract.pdf";
const RECT = { x: 10, y: 20, width: 100, height: 12 };

function add(page: number, text = "a marked passage", stamp = "s1") {
  return addMark(PATH, { page, rects: [RECT], text, stamp });
}

describe("mark-store", () => {
  beforeEach(() => {
    __resetMarkStoreForTests();
  });

  it("keeps marks in page order, then creation order", () => {
    add(3, "third");
    add(1, "first");
    add(3, "fourth");
    expect(getMarks(PATH).map((m) => m.text)).toEqual(["first", "third", "fourth"]);
  });

  it("returns only the marks on a page", () => {
    add(1);
    add(2);
    expect(marksOnPage(PATH, 2)).toHaveLength(1);
    expect(marksOnPage(PATH, 5)).toEqual([]);
  });

  it("lists pages carrying a mark once, ascending", () => {
    add(4);
    add(2);
    add(4);
    expect(pagesWithMarks(PATH)).toEqual([2, 4]);
  });

  it("refuses a mark with no rectangle — it could never be drawn", () => {
    expect(addMark(PATH, { page: 1, rects: [], text: "x", stamp: "s1" })).toBeNull();
    expect(getMarks(PATH)).toEqual([]);
  });

  it("truncates a snapshot and a note rather than storing them whole", () => {
    const mark = addMark(PATH, {
      page: 1,
      rects: [RECT],
      text: "x".repeat(MAX_MARK_TEXT + 500),
      note: "y".repeat(MAX_NOTE_TEXT + 500),
      stamp: "s1",
    });
    expect(mark!.text).toHaveLength(MAX_MARK_TEXT);
    expect(mark!.note).toHaveLength(MAX_NOTE_TEXT);
  });

  it("stops at the per-document cap instead of growing without bound", () => {
    for (let i = 0; i < MAX_MARKS_PER_DOC; i++) add(1);
    expect(getMarks(PATH)).toHaveLength(MAX_MARKS_PER_DOC);
    expect(add(1)).toBeNull();
  });

  it("edits and deletes by id", () => {
    const mark = add(1)!;
    setMarkNote(PATH, mark.id, "look here");
    expect(getMarks(PATH)[0]!.note).toBe("look here");
    removeMark(PATH, mark.id);
    expect(getMarks(PATH)).toEqual([]);
  });

  it("ignores a note set on a mark that is already gone", () => {
    // The note card saves on unmount, which happens after a delete.
    const mark = add(1)!;
    removeMark(PATH, mark.id);
    setMarkNote(PATH, mark.id, "resurrect me");
    expect(getMarks(PATH)).toEqual([]);
  });

  it("notifies subscribers for the document that changed, and no other", () => {
    const seen: string[] = [];
    const stop = subscribeMarks((p) => seen.push(p));
    add(1);
    addMark("/docs/other.pdf", { page: 1, rects: [RECT], text: "x", stamp: "s1" });
    stop();
    expect(seen).toEqual([PATH, "/docs/other.pdf"]);
  });

  describe("marksAreStale", () => {
    it("is false while the file is the one the marks were made against", () => {
      add(1, "text", "s1");
      expect(marksAreStale(PATH, "s1")).toBe(false);
    });

    it("is true once the file has changed — the marks are kept, not dropped", () => {
      add(1, "text", "s1");
      expect(marksAreStale(PATH, "s2")).toBe(true);
      // The index cache discards on a stamp change because it can recompute.
      // A mark is the reader's own work, so it survives.
      expect(getMarks(PATH)).toHaveLength(1);
    });

    it("says nothing when the document has no stamp at all", () => {
      add(1, "text", "");
      expect(marksAreStale(PATH, "")).toBe(false);
    });
  });

  describe("sanitizeStoredMarks", () => {
    const good = {
      id: "a",
      page: 1,
      rects: [RECT],
      text: "t",
      note: "",
      createdAt: 1,
      stamp: "s1",
    };

    it("reads back what it wrote", () => {
      const docs = sanitizeStoredMarks({ version: 1, docs: [{ path: PATH, marks: [good] }] });
      expect(docs).toEqual([{ path: PATH, marks: [good] }]);
    });

    it("drops a mark with no rectangle instead of failing the whole document", () => {
      const docs = sanitizeStoredMarks({
        version: 1,
        docs: [{ path: PATH, marks: [{ ...good, id: "b", rects: [] }, good] }],
      });
      expect(docs[0]!.marks.map((m) => m.id)).toEqual(["a"]);
    });

    it("discards a file written by an unknown schema rather than guessing", () => {
      expect(sanitizeStoredMarks({ version: 99, docs: [{ path: PATH, marks: [good] }] })).toEqual([]);
      expect(sanitizeStoredMarks(null)).toEqual([]);
      expect(sanitizeStoredMarks({ version: 1 })).toEqual([]);
    });
  });
});
