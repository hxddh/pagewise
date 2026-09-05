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
  confirmFinding,
  setFindingClaim,
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

  it("finds a moved file's record by its fingerprint and re-keys it", async () => {
    // Renamed or moved, the file is the same file, and the reader's record has
    // to follow it. Until 12.0 it stayed under the old path — visible to no one.
    write();
    await flushFindingStore();
    __resetFindingStoreForTests();
    // Write it back under the old path with an identity, as a 12.0 flush would.
    disk = {
      version: 2,
      docs: [
        {
          path: "/old/paper.pdf",
          identity: "fnv1a64:abc:100",
          findings: [
            { id: "a", pages: [2], claim: "kept", evidence: "", createdAt: 1, stamp: "s" },
          ],
        },
      ],
    };
    const found = await loadFindings("/new/paper.pdf", "fnv1a64:abc:100");
    expect(found.map((f) => f.id)).toEqual(["a"]);
    await flushFindingStore();
    const stored = disk as { docs: Array<{ path: string; identity?: string }> };
    expect(stored.docs.map((d) => d.path)).toEqual(["/new/paper.pdf"]);
    expect(stored.docs[0]?.identity).toBe("fnv1a64:abc:100");
  });

  it("does not adopt another file's record when the fingerprints differ", async () => {
    disk = {
      version: 2,
      docs: [
        {
          path: "/old/paper.pdf",
          identity: "fnv1a64:abc:100",
          findings: [
            { id: "a", pages: [2], claim: "kept", evidence: "", createdAt: 1, stamp: "s" },
          ],
        },
      ],
    };
    expect(await loadFindings("/new/other.pdf", "fnv1a64:zzz:999")).toEqual([]);
    expect(await loadFindings("/new/other.pdf")).toEqual([]);
  });

  it("keeps a whole answer beside its one-line claim, and where it came from", () => {
    const f = write({
      claim: "Eight weeks.…",
      body: "| week | n |\n|---|---|\n| 8 | 40 |\n\nEight weeks, **unless** the site closed early.",
      source: { messageId: "msg-7" },
      author: "reader",
    });
    expect(f?.body).toContain("**unless**");
    expect(f?.source).toEqual({ messageId: "msg-7" });
    // And it survives the disk.
    const [doc] = sanitizeStoredFindings({ version: 2, docs: [{ path: PATH, findings: [f] }] });
    expect(doc?.findings[0]?.body).toBe(f?.body);
  });

  it("lets the reader vouch for a claim, or rewrite it and vouch by doing so", () => {
    const f = write();
    expect(f?.confirmedAt).toBeUndefined();
    confirmFinding(PATH, f!.id);
    expect(getFindings(PATH)[0]?.confirmedAt).toBeTypeOf("number");
    confirmFinding(PATH, f!.id, false);
    expect(getFindings(PATH)[0]?.confirmedAt).toBeUndefined();

    expect(setFindingClaim(PATH, f!.id, "  The sample was collected in April.  ")).toBe(true);
    const edited = getFindings(PATH)[0]!;
    expect(edited.claim).toBe("The sample was collected in April.");
    expect(edited.confirmedAt).toBeTypeOf("number");
    expect(edited.evidence, "only the sentence changes").toBe(f!.evidence);
    expect(setFindingClaim(PATH, f!.id, "   ")).toBe(false);
  });

  it("carries a confirmed entry forward to the version of the file it was checked on", () => {
    const f = write({ stamp: "stamp-1" });
    confirmFinding(PATH, f!.id, true, "stamp-2");
    expect(getFindings(PATH)[0]?.stamp).toBe("stamp-2");
    expect(findingsAreStale(PATH, "stamp-2")).toBe(false);
    // And a rewrite does the same.
    const g = write({ stamp: "stamp-1", claim: "Another." });
    setFindingClaim(PATH, g!.id, "Another, checked.", "stamp-2");
    expect(getFindings(PATH).find((x) => x.id === g!.id)?.stamp).toBe("stamp-2");
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

    it("reads a record written by 9.x–11.x intact", () => {
      // The store's version went 1 → 2 at 12.0. Before `migrateStored`, that
      // bump would have emptied every reader's record on first launch — the
      // stores' own comments said so, and it is why 9.0 opened a second file
      // rather than touch the first. This is the case that proves the bump
      // is now safe.
      const v1 = {
        version: 1,
        docs: [
          {
            path: PATH,
            findings: [
              { id: "a", pages: [2], claim: "kept", evidence: "…", createdAt: 1, stamp: "s" },
              { id: "b", pages: [3], claim: "also kept", evidence: "", createdAt: 2, stamp: "s", struck: true },
            ],
          },
        ],
      };
      const docs = sanitizeStoredFindings(v1);
      expect(docs).toHaveLength(1);
      expect(docs[0]?.findings.map((f) => f.id)).toEqual(["a", "b"]);
      expect(docs[0]?.findings[1]?.struck).toBe(true);
    });

    it("keeps a record from a later PageWise aside rather than overwriting it", async () => {
      // A downgrade. The store reads as empty; the later version's blob is
      // stashed beside the key and a flush must not replace it.
      disk = { version: 99, docs: [{ path: PATH, findings: [] }] };
      const seen = new Map<string, unknown>();
      const { LazyStore } = await import("@tauri-apps/plugin-store");
      LazyStore.prototype.set = async function (key: string, value: unknown) {
        seen.set(key, value);
        if (key === "findings") disk = value;
      };
      LazyStore.prototype.get = (async function (key: string) {
        return key === "findings" ? disk : (seen.get(key) ?? null);
      }) as typeof LazyStore.prototype.get;
      await loadFindings(PATH);
      expect(getFindings(PATH)).toEqual([]);
      expect(seen.get("findings.newer")).toEqual({
        version: 99,
        docs: [{ path: PATH, findings: [] }],
      });
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
