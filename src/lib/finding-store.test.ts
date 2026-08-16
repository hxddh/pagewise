import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** One shared blob, so a flush and a reload see the same bytes a disk would. */
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

import {
  __resetFindingStoreForTests,
  activeFindings,
  addFinding,
  findingsAreStale,
  findingsOnPage,
  flushFindingStore,
  getFindings,
  isSuperseded,
  loadFindings,
  normalizePages,
  pagesWithFindings,
  removeFinding,
  reviseFinding,
  sanitizeStoredFindings,
  setFindingStruck,
  MAX_FINDING_PAGES,
} from "./finding-store";

const PATH = "/docs/paper.pdf";
const STAMP = "stamp-1";

beforeEach(() => {
  disk = null;
  __resetFindingStoreForTests();
});
afterEach(() => {
  __resetFindingStoreForTests();
});

const write = (over: Partial<Parameters<typeof addFinding>[1]> = {}) =>
  addFinding(PATH, {
    pages: [2],
    claim: "The sample was collected in March.",
    evidence: "…collected in March of that year…",
    stamp: STAMP,
    ...over,
  });

/**
 * The store behind the agent's memory.
 *
 * Modelled on the mark store, which solved the same problems first: a
 * serialized read-modify-write so a burst of writes cannot lose one, a stamp so
 * a changed file is flagged rather than silently trusted, and validation that
 * drops only what is genuinely unusable.
 *
 * It is a SEPARATE store file. Putting findings into `marks.json` would mean
 * bumping that file's version, and `sanitizeStoredMarks` returns [] on a
 * version it does not recognise — every existing reader's marks would be
 * discarded on first launch.
 */
describe("finding store", () => {
  it("writes a finding and keeps it on its pages", () => {
    const f = write({ pages: [3, 1] });
    expect(f).not.toBeNull();
    // Normalized on the way in, so callers never depend on the order they gave.
    expect(f?.pages).toEqual([1, 3]);
    expect(findingsOnPage(PATH, 3)).toHaveLength(1);
    expect(findingsOnPage(PATH, 2)).toHaveLength(0);
    expect(pagesWithFindings(PATH)).toEqual([1, 3]);
  });

  it("refuses a finding with no pages", () => {
    // The one thing this record must never hold: a claim the reader cannot
    // check against anything. See the design note in §5 — it is a requirement,
    // not a validation detail.
    expect(write({ pages: [] })).toBeNull();
    expect(write({ pages: [0, -4, 1.5] })).toBeNull();
    expect(getFindings(PATH)).toHaveLength(0);
  });

  it("refuses an empty claim", () => {
    expect(write({ claim: "   " })).toBeNull();
    expect(getFindings(PATH)).toHaveLength(0);
  });

  it("caps the pages one claim may cite", () => {
    const many = Array.from({ length: MAX_FINDING_PAGES + 10 }, (_, i) => i + 1);
    expect(normalizePages(many)).toHaveLength(MAX_FINDING_PAGES);
  });

  it("survives a reload", async () => {
    // The whole point of the record: it outlives the run that produced it.
    write({ pages: [7], claim: "Water boils at 100C at sea level." });
    await flushFindingStore();

    __resetFindingStoreForTests();
    const loaded = await loadFindings(PATH);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.claim).toBe("Water boils at 100C at sea level.");
    expect(loaded[0]?.pages).toEqual([7]);
  });

  it("flags findings written against another version of the file", () => {
    write();
    expect(findingsAreStale(PATH, STAMP)).toBe(false);
    expect(findingsAreStale(PATH, "stamp-2")).toBe(true);
    // No stamp to compare against is not a claim of staleness.
    expect(findingsAreStale(PATH, "")).toBe(false);
  });

  describe("revision", () => {
    it("supersedes the old claim without erasing it", () => {
      const first = write({ claim: "The trial ran for six weeks." });
      const second = reviseFinding(PATH, first!.id, {
        pages: [2, 5],
        claim: "The trial ran for eight weeks.",
        evidence: "…over an eight-week period…",
        why: "Page 5 gives the duration directly; page 2 was the pilot.",
        stamp: STAMP,
      });

      expect(second).not.toBeNull();
      expect(second?.supersedes).toBe(first!.id);
      expect(second?.why).toContain("pilot");

      // Both are kept — the history is the point.
      expect(getFindings(PATH)).toHaveLength(2);
      const all = getFindings(PATH);
      expect(isSuperseded(all, first!.id)).toBe(true);

      // Only the correction is told to the agent.
      const active = activeFindings(PATH);
      expect(active).toHaveLength(1);
      expect(active[0]?.claim).toBe("The trial ran for eight weeks.");
    });

    it("refuses to revise something already revised", () => {
      // Two live corrections of one claim is a fork, and this record is a
      // single timeline by design ("不分叉").
      const first = write();
      reviseFinding(PATH, first!.id, { pages: [2], claim: "Second.", stamp: STAMP });
      expect(
        reviseFinding(PATH, first!.id, { pages: [2], claim: "Third.", stamp: STAMP }),
      ).toBeNull();
      expect(activeFindings(PATH)).toHaveLength(1);
    });

    it("refuses to revise a finding that does not exist", () => {
      expect(reviseFinding(PATH, "nope", { pages: [1], claim: "x", stamp: STAMP })).toBeNull();
    });
  });

  describe("the reader's correction", () => {
    it("stops telling the agent a struck finding", () => {
      // Without this the reader cannot correct the agent's memory, and a memory
      // that cannot be corrected is a liability rather than a feature.
      const f = write();
      expect(activeFindings(PATH)).toHaveLength(1);

      setFindingStruck(PATH, f!.id, true);
      expect(activeFindings(PATH)).toHaveLength(0);
      // Still on screen, so the reader can see what they struck and undo it.
      expect(getFindings(PATH)).toHaveLength(1);

      setFindingStruck(PATH, f!.id, false);
      expect(activeFindings(PATH)).toHaveLength(1);
    });

    it("survives a struck finding across a reload", async () => {
      const f = write();
      setFindingStruck(PATH, f!.id, true);
      await flushFindingStore();

      __resetFindingStoreForTests();
      await loadFindings(PATH);
      expect(getFindings(PATH)).toHaveLength(1);
      expect(activeFindings(PATH)).toHaveLength(0);
    });

    it("removes a finding outright", () => {
      const f = write();
      removeFinding(PATH, f!.id);
      expect(getFindings(PATH)).toHaveLength(0);
    });
  });

  describe("corrupt stored data", () => {
    it("never blocks a document from opening", () => {
      expect(sanitizeStoredFindings(null)).toEqual([]);
      expect(sanitizeStoredFindings({ version: 99, docs: [] })).toEqual([]);
      expect(sanitizeStoredFindings({ version: 1, docs: "nope" })).toEqual([]);
    });

    it("drops an unanchored claim rather than showing it", () => {
      const docs = sanitizeStoredFindings({
        version: 1,
        docs: [
          {
            path: PATH,
            findings: [
              { id: "a", pages: [], claim: "no anchor", evidence: "", createdAt: 1, stamp: "s" },
              { id: "b", pages: [4], claim: "anchored", evidence: "", createdAt: 2, stamp: "s" },
            ],
          },
        ],
      });
      expect(docs[0]?.findings.map((f) => f.id)).toEqual(["b"]);
    });
  });
});
