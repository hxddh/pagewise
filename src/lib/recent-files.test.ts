import { beforeEach, describe, expect, it, vi } from "vitest";

let disk: unknown = null;
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return disk;
    }
    async set(_key: string, value: unknown) {
      disk = value;
    }
    async save() {}
  },
}));

import { addRecentFile, getRecentFiles, updateRecentProgress } from "./recent-files";

beforeEach(() => {
  disk = null;
});

/**
 * The library row that says where you were.
 *
 * Until 12.0 a recent entry was a path, a name and a time, and every document
 * reopened at page 1. These hold the four fields that make "pick up where I
 * left off" possible, and the two rules that keep them honest: a reopen keeps
 * the progress of the last visit, and a corrupt field costs the field only.
 */
describe("recent files remember progress", () => {
  it("keeps progress across a reopen", async () => {
    await addRecentFile({ path: "/a.pdf", name: "a.pdf", kind: "pdf" });
    await updateRecentProgress("/a.pdf", { lastPage: 37, totalPages: 120, findingCount: 6, openCount: 2 });
    const [again] = await addRecentFile({ path: "/a.pdf", name: "a.pdf", kind: "pdf" });
    expect(again?.lastPage).toBe(37);
    expect(again?.totalPages).toBe(120);
    expect(again?.findingCount).toBe(6);
    expect(again?.openCount).toBe(2);
  });

  it("does not add a document it has not seen", async () => {
    await addRecentFile({ path: "/a.pdf", name: "a.pdf", kind: "pdf" });
    const files = await updateRecentProgress("/b.pdf", { lastPage: 3 });
    expect(files.map((f) => f.path)).toEqual(["/a.pdf"]);
  });

  it("drops a corrupt progress field without dropping the row", async () => {
    disk = [
      { path: "/a.pdf", name: "a.pdf", kind: "pdf", openedAt: 1, lastPage: -4, findingCount: "six", totalPages: 9 },
    ];
    const [file] = await getRecentFiles();
    expect(file?.path).toBe("/a.pdf");
    expect(file?.lastPage).toBeUndefined();
    expect(file?.findingCount).toBeUndefined();
    expect(file?.totalPages).toBe(9);
  });

  it("writes nothing when the progress did not change", async () => {
    await addRecentFile({ path: "/a.pdf", name: "a.pdf", kind: "pdf" });
    await updateRecentProgress("/a.pdf", { lastPage: 5 });
    const before = disk;
    await updateRecentProgress("/a.pdf", { lastPage: 5 });
    expect(disk).toBe(before);
  });
});
