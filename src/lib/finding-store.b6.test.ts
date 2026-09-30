import { beforeEach, describe, expect, it, vi } from "vitest";

/** One shared blob that can be told to refuse the next write. */
let disk: unknown = null;
let failSets = 0;
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return disk;
    }
    async set(_key: string, value: unknown) {
      if (failSets > 0) {
        failSets -= 1;
        throw new Error("disk full");
      }
      disk = value;
    }
    async save() {}
  },
}));

import {
  __resetFindingStoreForTests,
  addFinding,
  flushFindingStore,
  forgetFindings,
  getFindings,
  loadFindings,
} from "./finding-store";

const PATH = "/docs/paper.pdf";
const OTHER = "/docs/other.pdf";
const add = (path: string, claim: string) => addFinding(path, { pages: [2], claim, evidence: claim, stamp: "s" });

beforeEach(() => {
  disk = null;
  failSets = 0;
  __resetFindingStoreForTests();
});

describe("B6: a failed write, then a document switch (16.0)", () => {
  it("keeps the closed document's findings on disk", async () => {
    await loadFindings(PATH);
    add(PATH, "saved");
    await flushFindingStore();
    add(PATH, "unsaved when the write fails");
    failSets = 1;
    await flushFindingStore();
    expect(failSets).toBe(0);
    // The reader switches documents: the app forgets the closed one.
    forgetFindings(PATH);
    await loadFindings(OTHER);
    add(OTHER, "elsewhere");
    await flushFindingStore();

    forgetFindings(PATH);
    expect(getFindings(PATH)).toEqual([]);
    expect((await loadFindings(PATH)).map((f) => f.claim)).toEqual(["saved", "unsaved when the write fails"]);
  });

  it("reopening before the retry keeps the unsaved changes", async () => {
    await loadFindings(PATH);
    add(PATH, "unsaved");
    failSets = 1;
    await flushFindingStore();
    forgetFindings(PATH);
    expect((await loadFindings(PATH)).map((f) => f.claim)).toEqual(["unsaved"]);
  });
});
