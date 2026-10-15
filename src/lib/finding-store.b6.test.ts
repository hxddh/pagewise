import { beforeEach, describe, expect, it } from "vitest";

import { useMemoryStoreBackend } from "./store-testkit";

import {
  __resetFindingStoreForTests,
  addFinding,
  flushFindingStore,
  forgetFindings,
  getFindings,
  loadFindings,
} from "./finding-store";

/** The store's disk, in memory: a write can be told to fail, as a full one does. */
const store = useMemoryStoreBackend();

const PATH = "/docs/paper.pdf";
const OTHER = "/docs/other.pdf";
const add = (path: string, claim: string) => addFinding(path, { pages: [2], claim, evidence: claim, stamp: "s" });

beforeEach(() => {
  store.reset();
  __resetFindingStoreForTests();
});

describe("B6: a failed write, then a document switch (16.0)", () => {
  it("keeps the closed document's findings on disk", async () => {
    await loadFindings(PATH);
    add(PATH, "saved");
    await flushFindingStore();
    add(PATH, "unsaved when the write fails");
    store.failNextWrite();
    await flushFindingStore();
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
    store.failNextWrite();
    await flushFindingStore();
    forgetFindings(PATH);
    expect((await loadFindings(PATH)).map((f) => f.claim)).toEqual(["unsaved"]);
  });
});
