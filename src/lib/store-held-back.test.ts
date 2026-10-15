import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bodyFileName } from "./atomic-store";
import {
  __resetFindingStoreForTests,
  addFinding,
  flushFindingStore,
  getFindings,
  loadFindings,
  MAX_FINDINGS_PER_DOC,
  MAX_FINDINGS_TOTAL,
} from "./finding-store";
import {
  __resetStoreHealthForTests,
  subscribeStoreProblem,
  type StoreProblemReport,
} from "./store-health";
import { storeKey, useMemoryStoreBackend } from "./store-testkit";

/**
 * Two writes a store must hold back rather than make (21.0).
 *
 * Both used to cost the reader text they could not get back, with nothing on
 * screen to say so: a downgraded build wrote its own documents over a later
 * version's record and then pruned every other document's bodies, and the
 * total cap dropped whole documents at flush, in file order.
 */
const store = useMemoryStoreBackend();
const disk = storeKey(store, "findings.json", "findings");

const PATH = "/docs/paper.pdf";
const OTHER = "/docs/other.pdf";
const BODY_ID = "11111111-1111-4111-8111-111111111111";

let reports: StoreProblemReport[] = [];
let unsubscribe = () => {};

beforeEach(() => {
  store.reset();
  __resetFindingStoreForTests();
  __resetStoreHealthForTests();
  reports = [];
  unsubscribe = subscribeStoreProblem((r) => reports.push(r));
});
afterEach(() => {
  unsubscribe();
  __resetFindingStoreForTests();
  __resetStoreHealthForTests();
});

const stored = (id: string, page = 1) => ({
  id,
  pages: [page],
  claim: `claim ${id}`,
  evidence: "",
  createdAt: 1,
  stamp: "s",
});

describe("a record written by a later PageWise", () => {
  const later = {
    version: 99,
    docs: [{ path: OTHER, findings: [{ ...stored(BODY_ID), body: undefined }] }],
  };

  beforeEach(() => {
    disk.seed(later);
    store.seed(bodyFileName(BODY_ID), "the whole answer the reader kept");
  });

  it("is not written over by an edit made here", async () => {
    await loadFindings(PATH);
    addFinding(PATH, { pages: [2], claim: "made after a downgrade", stamp: "s", body: "x" });
    await flushFindingStore();

    expect(disk.peek(), "the later version's record is untouched").toEqual(later);
  });

  it("keeps every other document's bodies", async () => {
    await loadFindings(PATH);
    addFinding(PATH, { pages: [2], claim: "made after a downgrade", stamp: "s" });
    await flushFindingStore();

    expect(store.files.has(bodyFileName(BODY_ID)), "prune must not run").toBe(true);
  });

  it("keeps the edit in memory, and says it is not saved", async () => {
    await loadFindings(PATH);
    addFinding(PATH, { pages: [2], claim: "made after a downgrade", stamp: "s" });
    await flushFindingStore();

    expect(getFindings(PATH)).toHaveLength(1);
    expect(reports).toEqual([{ file: "findings.json", problem: "newer" }]);
  });
});

describe("the total cap", () => {
  // The edited document first in the file, then enough other documents to
  // reach the total exactly: one more finding on the first document is one
  // past the cap.
  const others = Math.floor((MAX_FINDINGS_TOTAL - 1) / MAX_FINDINGS_PER_DOC);
  const docs = [
    { path: PATH, findings: [stored("p-0")] },
    ...Array.from({ length: others }, (_, d) => ({
      path: `/docs/full-${d}.pdf`,
      findings: Array.from({ length: MAX_FINDINGS_PER_DOC }, (_, i) => stored(`d${d}-${i}`)),
    })),
  ];
  const last = {
    path: "/docs/last.pdf",
    findings: Array.from(
      { length: MAX_FINDINGS_TOTAL - 1 - others * MAX_FINDINGS_PER_DOC },
      (_, i) => stored(`last-${i}`),
    ),
  };

  beforeEach(() => {
    disk.seed({ version: 2, docs: last.findings.length > 0 ? [...docs, last] : docs });
  });

  it("never costs another document its record", async () => {
    await loadFindings(PATH);
    addFinding(PATH, { pages: [3], claim: "one past the total", stamp: "s" });
    await flushFindingStore();

    const written = disk.peek<{ docs: { path: string; findings: unknown[] }[] }>()!;
    const count = written.docs.reduce((n, d) => n + d.findings.length, 0);
    expect(count).toBe(MAX_FINDINGS_TOTAL);
    for (const doc of [...docs.slice(1), last]) {
      if (doc.findings.length === 0) continue;
      expect(written.docs.find((d) => d.path === doc.path)?.findings).toHaveLength(
        doc.findings.length,
      );
    }
  });

  it("keeps the edited document as the disk had it, and says the record is full", async () => {
    await loadFindings(PATH);
    addFinding(PATH, { pages: [3], claim: "one past the total", stamp: "s" });
    await flushFindingStore();

    const written = disk.peek<{ docs: { path: string; findings: unknown[] }[] }>()!;
    expect(written.docs.find((d) => d.path === PATH)?.findings).toHaveLength(1);
    expect(getFindings(PATH), "the edit is still on screen, for when there is room").toHaveLength(2);
    expect(reports).toEqual([{ file: "findings.json", problem: "full" }]);
  });
});
