import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useMemoryStoreBackend } from "./store-testkit";
import {
  __resetStoreHealthForTests,
  reportWriteFailed,
  reportWriteSucceeded,
  subscribeWriteHealth,
  unsavedWrites,
  type WriteHealthChange,
} from "./store-health";
import { __resetFindingStoreForTests, addFinding, flushFindingStore, loadFindings } from "./finding-store";
import { __resetMarkStoreForTests, addMark, flushMarkStore, loadMarks } from "./mark-store";

// The chat store's hydrate path pulls in settings; the save is what is under test.
vi.mock("./messages-utils", () => ({
  hydrateChatMessages: async (m: unknown) => m,
  normalizeUIMessages: (m: unknown) => (Array.isArray(m) ? m : []),
}));
vi.mock("./persist-messages", () => ({
  prepareMessagesForPersist: (m: unknown) => m,
}));

const { clearChat, saveChat } = await import("../chat/persist");

/** The disk, in memory: writes can be made to fail, as a full disk does. */
const disk = useMemoryStoreBackend();
const PATH = "/docs/paper.pdf";

/** What the app shell's toast subscriber would see: one entry per change. */
let changes: WriteHealthChange[];
const toasts = () => changes.filter((c) => c.failed).map((c) => c.kind);
const mark = (text: string) =>
  addMark(PATH, { page: 1, rects: [{ x: 0, y: 0, width: 10, height: 10 }], text, stamp: "s" });

beforeEach(() => {
  disk.reset();
  __resetFindingStoreForTests();
  __resetMarkStoreForTests();
  __resetStoreHealthForTests();
  changes = [];
  subscribeWriteHealth((c) => changes.push(c));
});

afterEach(() => __resetStoreHealthForTests());

describe("store health: a failed write is said once and kept up until a save lands (24.0)", () => {
  it("dedupes repeated failures and clears on success", () => {
    reportWriteFailed("findings");
    reportWriteFailed("findings");
    expect(toasts()).toEqual(["findings"]);
    expect(unsavedWrites()).toEqual(["findings"]);
    reportWriteSucceeded("findings");
    expect(unsavedWrites()).toEqual([]);
    // A success with nothing outstanding is not news.
    reportWriteSucceeded("findings");
    expect(changes).toEqual([
      { kind: "findings", failed: true },
      { kind: "findings", failed: false },
    ]);
  });

  it("keeps the snapshot stable until something changes", () => {
    const before = unsavedWrites();
    reportWriteSucceeded("conversation");
    expect(unsavedWrites()).toBe(before);
    reportWriteFailed("conversation");
    expect(unsavedWrites()).not.toBe(before);
  });
});

describe("conversation saves (24.0)", () => {
  const messages = [{ id: "m1", role: "user", parts: [] }] as never[];

  it("a failing save raises the toast once and sets the indicator", async () => {
    disk.failWrites();
    await expect(saveChat(PATH, messages)).rejects.toThrow();
    await expect(saveChat(PATH, messages)).rejects.toThrow();
    await expect(saveChat(PATH, messages)).rejects.toThrow();
    expect(toasts()).toEqual(["conversation"]);
    expect(unsavedWrites()).toEqual(["conversation"]);
  });

  it("a later successful save clears the indicator", async () => {
    disk.failWrites();
    await expect(saveChat(PATH, messages)).rejects.toThrow();
    disk.allowWrites();
    await saveChat(PATH, messages);
    expect(unsavedWrites()).toEqual([]);
    expect(changes[changes.length - 1]).toEqual({ kind: "conversation", failed: false });
  });

  it("a clear that lands after a failed save clears the indicator, and a failing one says so", async () => {
    disk.failWrites();
    await expect(saveChat(PATH, messages)).rejects.toThrow();
    await expect(clearChat(PATH)).rejects.toThrow();
    expect(toasts()).toEqual(["conversation"]);
    disk.allowWrites();
    await clearChat(PATH);
    expect(unsavedWrites()).toEqual([]);
  });
});

describe("annotation writes (24.0)", () => {
  it("a failing flush raises the toast once, and retries do not repeat it", async () => {
    await loadMarks(PATH);
    disk.failWrites();
    mark("one");
    await flushMarkStore();
    mark("two");
    await flushMarkStore();
    await flushMarkStore();
    expect(toasts()).toEqual(["annotations"]);
    expect(unsavedWrites()).toEqual(["annotations"]);
  });

  it("the re-queued write landing clears the indicator", async () => {
    await loadMarks(PATH);
    disk.failWrites();
    mark("kept");
    await flushMarkStore();
    disk.allowWrites();
    // Nothing new: the failed edit is still queued, and this is its retry.
    await flushMarkStore();
    expect(unsavedWrites()).toEqual([]);
    expect(disk.peek<{ marks: { docs: unknown[] } }>("marks.json")?.marks.docs).toHaveLength(1);
  });
});

describe("finding writes (24.0)", () => {
  const add = (claim: string) => addFinding(PATH, { pages: [2], claim, evidence: claim, stamp: "s" });

  it("a failing flush raises the toast once, and retries do not repeat it", async () => {
    await loadFindings(PATH);
    disk.failWrites();
    add("one");
    await flushFindingStore();
    add("two");
    await flushFindingStore();
    expect(toasts()).toEqual(["findings"]);
    expect(unsavedWrites()).toEqual(["findings"]);
  });

  it("a later successful flush clears the indicator", async () => {
    await loadFindings(PATH);
    disk.failWrites();
    add("kept");
    await flushFindingStore();
    disk.allowWrites();
    await flushFindingStore();
    expect(unsavedWrites()).toEqual([]);
    expect(changes[changes.length - 1]).toEqual({ kind: "findings", failed: false });
  });

  it("each kind is said and cleared on its own", async () => {
    await loadFindings(PATH);
    await loadMarks(PATH);
    disk.failWrites();
    add("f");
    mark("m");
    await flushFindingStore();
    await flushMarkStore();
    expect(unsavedWrites()).toEqual(["findings", "annotations"]);
    disk.allowWrites();
    await flushMarkStore();
    expect(unsavedWrites()).toEqual(["findings"]);
  });
});
