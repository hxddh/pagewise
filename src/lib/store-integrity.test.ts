import { beforeEach, describe, expect, it } from "vitest";

import {
  addMark,
  flushMarkStore,
  forgetMarks,
  getMarks,
  loadMarks,
  __resetMarkStoreForTests,
} from "./mark-store";
import {
  addFinding,
  flushFindingStore,
  getFindings,
  loadFindings,
  __resetFindingStoreForTests,
} from "./finding-store";
import { unreadableStores, __resetStoreHealthForTests } from "./store-health";
import { useMemoryStoreBackend } from "./store-testkit";

/**
 * What a store does with a file it cannot read.
 *
 * The failure the 20.0 review measured: the store plugin swallowed the parse
 * error, so a torn `marks.json` read back as *no marks* — and the next flush,
 * 400 ms later, wrote that emptiness over the file. The reader's own work was
 * gone, and nothing had said a word.
 *
 * The two halves of the fix, asserted here at the store level: the file is never
 * written over, and the app is told which file it could not read (the stores
 * themselves keep answering "no data" — a corrupt store must not block opening
 * a document, which is a rule from 12.0).
 */
const store = useMemoryStoreBackend();
const TORN = '{\n  "marks": {\n    "version": 2,\n    "docs": [{"path": "/docs/a.pdf", "marks": [{"id"';

const PATH = "/docs/a.pdf";
const RECT = { x: 1, y: 2, width: 3, height: 4 };

beforeEach(() => {
  store.reset();
  __resetStoreHealthForTests();
  __resetMarkStoreForTests();
  __resetFindingStoreForTests();
});

describe("a store file that cannot be read", () => {
  it("is never written over, and is reported instead of read as empty", async () => {
    store.seed("marks.json", TORN);

    expect(await loadMarks(PATH)).toEqual([]);
    expect(unreadableStores().map((u) => u.file)).toEqual(["marks.json"]);

    // The reader marks something anyway — the app must stay usable — and the
    // flush that follows has to refuse rather than replace the file.
    addMark(PATH, { page: 1, rects: [RECT], text: "kept", stamp: "s1" });
    await flushMarkStore();
    expect(store.files.get("marks.json")).toBe(TORN);
    expect(store.writes).toEqual([]);

    // The marks are still in memory: a failed write must not drop them (16.0).
    expect(getMarks(PATH).map((m) => m.text)).toEqual(["kept"]);
    forgetMarks(PATH);
  });

  it("does not stop a second, healthy store from working", async () => {
    store.seed("findings.json", "{not json at all");
    await loadFindings(PATH);
    expect(await loadMarks(PATH)).toEqual([]);
    addMark(PATH, { page: 1, rects: [RECT], text: "saved", stamp: "s1" });
    await flushMarkStore();
    expect(store.peek<{ marks: { docs: Array<{ path: string }> } }>("marks.json")?.marks.docs).toEqual([
      { path: PATH, marks: [expect.objectContaining({ text: "saved" })] },
    ]);
  });

  it("keeps a finding that cannot be written, and writes it once the file is back", async () => {
    store.seed("findings.json", TORN);
    await loadFindings(PATH);
    addFinding(PATH, { pages: [2], claim: "kept while the file is broken", stamp: "s1" });
    await flushFindingStore();
    expect(store.files.get("findings.json")).toBe(TORN);
    expect(getFindings(PATH).map((f) => f.claim)).toEqual(["kept while the file is broken"]);

    // The reader moves the broken file aside; the store's next read succeeds.
    store.seed("findings.json", '{"findings": {"version": 2, "docs": []}}');
    await flushFindingStore();
    expect(store.peek<{ findings: { docs: Array<{ findings: Array<{ claim: string }> }> } }>("findings.json")
      ?.findings.docs[0]?.findings.map((f) => f.claim)).toEqual(["kept while the file is broken"]);
  });
});
