import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

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

import { createDocumentTools, newReadBudget } from "./index";
import { docCache } from "../doc-cache";
import {
  __resetFindingStoreForTests,
  activeFindings,
  getFindings,
} from "../finding-store";
import { PRUNE_DOCUMENT_TOOLS, NOTE_FINDING_TOOL, REVISE_FINDING_TOOL } from "../document-tool-names";

const PATH = "/docs/paper.pdf";

function loadDoc() {
  docCache.set({
    path: PATH,
    name: "paper.pdf",
    kind: "pdf",
    page_count: 9,
    stamp: "stamp-1",
    pages: [],
    outline: [],
    links: [],
    figures: [],
  } as never);
}

const options = { context: { defaultDocPath: PATH } } as never;

beforeEach(() => {
  disk = null;
  __resetFindingStoreForTests();
  loadDoc();
});

/**
 * The two tools that write.
 *
 * The store's own tests cover what it stores. These cover the seam the store
 * cannot see: what the model is actually allowed to send, and what the run
 * pays for a write.
 */
describe("the writing tools", () => {
  it("refuses a claim with no pages at the schema, not just at the store", async () => {
    // Belt and braces on the one requirement this record cannot bend. The store
    // also refuses it, but a schema refusal is reported back to the model as a
    // validation error it can correct, rather than as a silent no-op.
    const { note_finding } = createDocumentTools(newReadBudget()) as never as {
      note_finding: { inputSchema: z.ZodTypeAny };
    };
    const parsed = note_finding.inputSchema.safeParse({ pages: [], claim: "something" });
    expect(parsed.success, "empty pages must not validate").toBe(false);

    expect(
      note_finding.inputSchema.safeParse({ pages: [3], claim: "something" }).success,
    ).toBe(true);
  });

  it("writes a finding without charging the read budget", async () => {
    // The read budget caps how much of the document one run may pull into
    // context. Writing pulls nothing, so charging it would make recording
    // compete with reading for the same allowance — and the agent would learn
    // to stop recording in exactly the long runs where the record helps most.
    const budget = newReadBudget();
    const tools = createDocumentTools(budget) as never as Record<
      string,
      { execute: (i: unknown, o: unknown) => Promise<unknown> }
    >;

    const before = budget.used;
    const result = (await tools.note_finding!.execute(
      { pages: [4, 2], claim: "The trial ran for eight weeks.", evidence: "…eight-week…" },
      options,
    )) as { recorded: boolean; pages: number[] };

    expect(result.recorded).toBe(true);
    expect(result.pages).toEqual([2, 4]);
    expect(budget.used, "a write must not consume the read allowance").toBe(before);
    expect(getFindings(PATH)).toHaveLength(1);
  });

  it("supersedes an earlier claim through revise_finding", async () => {
    const tools = createDocumentTools(newReadBudget()) as never as Record<
      string,
      { execute: (i: unknown, o: unknown) => Promise<unknown> }
    >;
    const first = (await tools.note_finding!.execute(
      { pages: [2], claim: "Six weeks." },
      options,
    )) as { id: string };

    const revision = (await tools.revise_finding!.execute(
      { id: first.id, pages: [5], claim: "Eight weeks.", why: "Page 5 states it directly." },
      options,
    )) as { revised: boolean; replaced: string };

    expect(revision.revised).toBe(true);
    expect(revision.replaced).toBe(first.id);
    // Both kept, one active.
    expect(getFindings(PATH)).toHaveLength(2);
    expect(activeFindings(PATH).map((f) => f.claim)).toEqual(["Eight weeks."]);
  });

  it("reports rather than throws when a revision cannot be applied", async () => {
    // A refused write must not end the run. The model gets a reason and can
    // carry on answering.
    const tools = createDocumentTools(newReadBudget()) as never as Record<
      string,
      { execute: (i: unknown, o: unknown) => Promise<unknown> }
    >;
    const result = (await tools.revise_finding!.execute(
      { id: "no-such-id", pages: [1], claim: "x" },
      options,
    )) as { revised: boolean; reason: string };
    expect(result.revised).toBe(false);
    expect(result.reason).toMatch(/no such finding/i);
  });

  it("keeps finding results out of the history pruner", () => {
    // Everything in PRUNE_DOCUMENT_TOOLS gets replaced by a one-line summary in
    // persisted history. These results are already one line — and they carry
    // the id that a later revise_finding has to name. Pruning it would leave
    // the agent able to see it was wrong and unable to say which claim it was
    // wrong about.
    expect(PRUNE_DOCUMENT_TOOLS.has(NOTE_FINDING_TOOL)).toBe(false);
    expect(PRUNE_DOCUMENT_TOOLS.has(REVISE_FINDING_TOOL)).toBe(false);
  });
});
