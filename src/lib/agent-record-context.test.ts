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
