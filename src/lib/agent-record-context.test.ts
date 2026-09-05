import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return null;
    }
    async set() {}
    async save() {}
  },
}));

import {
  buildRecordInstructions,
  selectFindingsForPrompt,
  RECORD_CHAR_BUDGET,
} from "./agent-record-context";
import {
  __resetFindingStoreForTests,
  addFinding,
  reviseFinding,
  setFindingStruck,
  type Finding,
} from "./finding-store";

const PATH = "/docs/paper.pdf";
beforeEach(() => __resetFindingStoreForTests());

const note = (over: Partial<Parameters<typeof addFinding>[1]> = {}) =>
  addFinding(PATH, { pages: [2], claim: "The trial ran eight weeks.", stamp: "s", ...over });

const fake = (n: number, claim: string): Finding => ({
  id: `f${n}`,
  pages: [n],
  claim,
  evidence: "",
  createdAt: n,
  stamp: "s",
});

/**
 * What the next question is told about what earlier ones established.
 *
 * This is the half of 9.0 that pays for the two writing tools. It rides on the
 * user message rather than the system prompt: the system block is what
 * providers cache first, and a record that grew each turn would invalidate the
 * whole ~1,472-token prefix on every question — turning the saving into a
 * permanent loss.
 */
describe("the record in the prompt", () => {
  it("says nothing when nothing has been established", () => {
    // A document with no record must cost exactly what it did before 9.1.
    expect(buildRecordInstructions(PATH)).toBe("");
    expect(buildRecordInstructions(null)).toBe("");
  });

  it("carries each claim with the pages it came from", () => {
    note({ pages: [4, 2], claim: "The trial ran eight weeks." });
    const out = buildRecordInstructions(PATH);
    expect(out).toContain("p2,4: The trial ran eight weeks.");
    // The instruction is the mechanism: without it the model has the record and
    // no reason to act on it.
    expect(out).toMatch(/do not re-read those pages/i);
  });

  it("never repeats a claim the reader struck out", () => {
    // The reader's correction has to actually take effect, or the record is a
    // memory that cannot be corrected — which is worse than none.
    const f = note({ claim: "Something the reader rejected." });
    setFindingStruck(PATH, f!.id, true);
    expect(buildRecordInstructions(PATH)).toBe("");
  });

  it("never repeats a claim its own revision replaced", () => {
    const first = note({ claim: "Six weeks." });
    reviseFinding(PATH, first!.id, { pages: [5], claim: "Eight weeks.", stamp: "s" });
    const out = buildRecordInstructions(PATH);
    expect(out).toContain("Eight weeks.");
    expect(out).not.toContain("Six weeks.");
  });

  it("stays inside its budget, and says what it left out", () => {
    // A document may hold 500 findings. Sending all of them would replace one
    // unbounded cost with another.
    const many = Array.from({ length: 200 }, (_, i) =>
      fake(i + 1, `Established claim number ${i + 1}, of a length typical for a real one.`),
    );
    const { lines, omitted } = selectFindingsForPrompt(many);
    const size = lines.join("\n").length;
    expect(size).toBeLessThanOrEqual(RECORD_CHAR_BUDGET);
    expect(omitted).toBeGreaterThan(0);
    expect(lines.length + omitted).toBe(many.length);
  });

  it("keeps the newest when it has to drop something", () => {
    // A revision is newer than the claim it corrects, by construction. Dropping
    // from the recent end would be most likely to drop exactly the corrections
    // and re-tell the agent something already known to be wrong.
    const many = Array.from({ length: 200 }, (_, i) =>
      fake(i + 1, `Established claim number ${i + 1}, of a length typical for a real one.`),
    );
    const { lines } = selectFindingsForPrompt(many);
    expect(lines[lines.length - 1], "the newest claim must survive").toContain("number 200");
    expect(lines.join("\n"), "the oldest is the one to drop").not.toContain("number 1,");
  });

  it("keeps what it did send in the order it was written", () => {
    // The record reads as a history. Selecting newest-first must not leave the
    // lines reversed on the page.
    const { lines } = selectFindingsForPrompt([fake(1, "First."), fake(2, "Second.")]);
    expect(lines[0]).toContain("First.");
    expect(lines[1]).toContain("Second.");
  });
});

/**
 * The second list.
 *
 * The 11.0 review's F1: a finding whose file had changed, or whose quoted
 * wording the page did not carry, still went out as "treat these as known".
 * The panel warned the reader; the model was told the opposite.
 */
describe("what the model is told to re-check", () => {
  const anchorsMod = () => import("./finding-anchors");
  const docCacheMod = () => import("./doc-cache");

  beforeEach(async () => {
    const { docCache } = await docCacheMod();
    docCache.set({ path: PATH, name: "p.pdf", kind: "pdf", totalPages: 9, stamp: "s", pages: [] } as never);
    const { clearFindingAnchors } = await anchorsMod();
    clearFindingAnchors();
  });

  it("moves a claim written on an earlier version of the file out of 'known'", () => {
    note({ claim: "Written before the file changed.", stamp: "old-stamp" });
    note({ claim: "Written on this version." });
    const out = buildRecordInstructions(PATH);
    const known = out.slice(0, out.indexOf("need re-checking"));
    const doubtful = out.slice(out.indexOf("need re-checking"));
    expect(known).toContain("Written on this version.");
    expect(known).not.toContain("Written before the file changed.");
    expect(doubtful).toContain("Written before the file changed.");
    expect(doubtful).toMatch(/do not treat these as established/i);
    expect(doubtful).toMatch(/read the cited page first/i);
  });

  it("moves a claim whose wording the page does not carry out of 'known'", async () => {
    const f = note({ claim: "Says twelve percent.", evidence: "twelve percent" });
    // What the panel already worked out, read back here without IPC.
    const anchors = await anchorsMod();
    vi.spyOn(anchors, "cachedPlacement").mockImplementation((_p, id) =>
      id === f!.id ? { status: "absent" } : null,
    );
    const out = buildRecordInstructions(PATH);
    expect(out).toContain("need re-checking");
    expect(out.slice(0, out.indexOf("need re-checking"))).not.toContain("twelve percent");
    vi.restoreAllMocks();
  });

  it("says nothing about a claim the reader vouched for, except that it is known", async () => {
    const { confirmFinding } = await import("./finding-store");
    const f = note({ claim: "Checked by hand.", evidence: "twelve percent" });
    confirmFinding(PATH, f!.id);
    const anchors = await anchorsMod();
    vi.spyOn(anchors, "cachedPlacement").mockReturnValue({ status: "absent" });
    const out = buildRecordInstructions(PATH);
    expect(out).toContain("Checked by hand.");
    expect(out).not.toContain("need re-checking");
    vi.restoreAllMocks();
  });

  it("never tells the model a claim on a page past the end of the document", () => {
    note({ claim: "On page 999.", pages: [999] });
    expect(buildRecordInstructions(PATH)).toBe("");
  });

  it("sends only the doubtful list when nothing is known", () => {
    note({ claim: "Old.", stamp: "old-stamp" });
    const out = buildRecordInstructions(PATH);
    expect(out).not.toContain("Already established");
    expect(out).toContain("need re-checking");
  });
});
