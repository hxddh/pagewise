import { beforeEach, describe, expect, it } from "vitest";

import { addFinding, flushFindingStore, __resetFindingStoreForTests } from "./finding-store";
import { addMark, flushMarkStore, __resetMarkStoreForTests } from "./mark-store";
import { useMemoryStoreBackend } from "./store-testkit";

/**
 * What one flush puts on disk, measured.
 *
 * Every store used to rewrite its whole file per flush, and the 20.0 review
 * measured where that ends: 10,000 marks = 4.48 MB pretty, 100 chats = 16.5 MB,
 * and a findings store at its caps with full bodies = ~104 MB — each rewritten
 * per 400/500/800 ms debounce, with the reader's own work inside.
 *
 * Two things changed. A finding's body is written once, beside the index
 * (`finding-bodies.ts`), so editing one does not reserialise the four thousand
 * others; and the findings flush waits 1.5 s instead of 400 ms. These tests
 * assert the bytes, not the debounce — a number that cannot move is a slogan.
 */
const store = useMemoryStoreBackend();

const PATH = "/docs/a.pdf";
const CLAIM = "The sample was collected in March, and the second wave in April.";
const EVIDENCE = "…collected in March of that year… the second wave began in April…";

beforeEach(() => {
  store.reset();
  __resetFindingStoreForTests();
  __resetMarkStoreForTests();
});

function bytesOf(file: string): number {
  return store.files.get(file)?.length ?? 0;
}

describe("write amplification", () => {
  it("writes each finding body once, and never again", async () => {
    const body = "answer text ".repeat(1_000); // ~12,000 characters
    for (let i = 0; i < 50; i++) {
      addFinding(PATH, { pages: [i + 1], claim: `${CLAIM} (${i})`, evidence: EVIDENCE, body, stamp: "s1" });
    }
    await flushFindingStore();

    const bodies = store.writes.filter((w) => w.name.startsWith("finding-bodies/"));
    expect(bodies).toHaveLength(50);

    // One more answer kept: one more body file, and one index rewrite. The 50
    // bodies already beside the index are not touched again.
    addFinding(PATH, { pages: [99], claim: "a later claim", evidence: "", body, stamp: "s1" });
    const before = store.writes.length;
    await flushFindingStore();
    const written = store.writes.slice(before);
    expect(written.filter((w) => w.name.startsWith("finding-bodies/"))).toHaveLength(1);
    // One body file and one index write: the 50 bodies already beside the index
    // are not touched again.
    expect(written).toHaveLength(2);
    expect(written.filter((w) => w.name === "findings.json")).toHaveLength(1);
  });

  it("keeps the bodies out of the index, and rewrites one body instead of the record", async () => {
    // A record at the per-document cap with a full-length body on each entry:
    // the shape the review measured at ~104 MB across documents, here ~10 MB in
    // one document — the same arithmetic, a tenth of the wall clock.
    const body = "x".repeat(20_000);
    for (let i = 0; i < 499; i++) {
      addFinding(PATH, { pages: [i + 1], claim: `${CLAIM} (${i})`, evidence: EVIDENCE, body, stamp: "s1" });
    }
    await flushFindingStore();

    const indexBytes = bytesOf("findings.json");
    const bodyBytes = store.writes
      .filter((w) => w.name.startsWith("finding-bodies/"))
      .reduce((total, w) => total + w.bytes, 0);
    expect(bodyBytes).toBeGreaterThan(9_000_000);
    // The index holds claims, evidence and flags — no body at all.
    expect(indexBytes).toBeLessThan(bodyBytes / 20);
    expect(store.files.get("findings.json")).not.toContain("xxxxx");

    // The reader keeps one more answer — the last the document has room for.
    // Before the split this flush rewrote every finding, bodies included:
    // ~10 MB per debounce, and ~104 MB at the store's total cap.
    addFinding(PATH, { pages: [500], claim: "one more", evidence: "", body, stamp: "s1" });
    const before = store.bytesWritten();
    await flushFindingStore();
    const flushBytes = store.bytesWritten() - before;
    expect(flushBytes).toBeGreaterThan(0);
    expect(flushBytes).toBeLessThan(0.03 * (indexBytes + bodyBytes));
  });

  it("records the marks store: one file, one write, ~4.6 MB at 10,000 marks", async () => {
    // Marks are anchored on rectangles, not on text, so there is no body to
    // split out of them: a full store is one 4.6 MB file per flush, and that is
    // the recorded number rather than a fixed one (the debounce is 400 ms).
    const rects = [{ x: 10, y: 20, width: 100, height: 12 }];
    for (let doc = 0; doc < 5; doc++) {
      const path = `/docs/${doc}.pdf`;
      for (let i = 0; i < 2_000; i++) {
        addMark(path, { page: (i % 300) + 1, rects, text: "a marked passage of some length", stamp: "s1" });
      }
    }
    await flushMarkStore();
    const written = store.writes.filter((w) => w.name === "marks.json");
    expect(written).toHaveLength(1);
    // 20,000 marks is the total cap; the five documents hold 10,000 here.
    expect(written[0]!.bytes).toBeGreaterThan(4_000_000);
    expect(written[0]!.bytes).toBeLessThan(5_500_000);
  });
});
