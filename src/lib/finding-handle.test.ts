import { beforeEach, describe, expect, it, vi } from "vitest";

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
  addFinding,
  findingHandle,
  resolveFindingId,
  FINDING_HANDLE_LEN,
} from "./finding-store";
import { buildRecordInstructions } from "./agent-record-context";
import { createReviseFindingTool } from "./agent-tools/tools/revise-finding";
import { docCache } from "./doc-cache";

/**
 * The identifier the agent is given, and whether it can be handed back.
 *
 * `revise_finding` has always taken "the finding being replaced", and the
 * record note has always ended by asking for a correction — while naming no
 * finding at all. Within one run `note_finding` returns an id, so the agent
 * could correct what it had just written; across runs, which is the only
 * reason this store is on disk, the instruction was unfollowable.
 *
 * These pin the round trip: what the note prints, that it is short enough to be
 * worth printing, and that what comes back resolves — or, when it is ambiguous,
 * that nothing is revised rather than the wrong thing.
 */

const PATH = "/docs/paper.pdf";

beforeEach(() => {
  disk = null;
  __resetFindingStoreForTests();
  docCache.clear();
  docCache.set({
    path: PATH,
    name: "paper.pdf",
    kind: "pdf",
    page_count: 9,
    stamp: "s",
    pages: [],
    outline: [],
    links: [],
    figures: [],
  } as never);
});

const note = (claim: string, pages = [1]) =>
  addFinding(PATH, { pages, claim, evidence: "", stamp: "s" })!;

describe("the record note names its findings", () => {
  it("prints an id the agent can quote back", () => {
    const finding = note("Revenue fell twelve percent.");
    const text = buildRecordInstructions(PATH);
    expect(text).toContain(`[${findingHandle(finding.id)}]`);
    expect(text).toContain("Revenue fell twelve percent.");
  });

  it("prints one that resolves to that finding and no other", () => {
    // The round trip, end to end: whatever the note printed has to be
    // something `revise_finding` accepts.
    const a = note("Revenue fell twelve percent.");
    const b = note("Costs were flat.", [2]);
    const text = buildRecordInstructions(PATH);

    const handles = [...text.matchAll(/\[([0-9a-f-]+)\]/g)].map((m) => m[1]!);
    expect(handles).toHaveLength(2);
    expect(resolveFindingId(PATH, handles[0]!)).toBe(a.id);
    expect(resolveFindingId(PATH, handles[1]!)).toBe(b.id);
  });

  it("spends a handful of characters on the id, not a uuid", () => {
    // A full uuid is 36 characters. At 500 findings per document against a
    // 2,000-character record budget, the identifier would take roughly a fifth
    // of the record away from the claims — paid on every question.
    const finding = note("Revenue fell twelve percent.");
    expect(findingHandle(finding.id)).toHaveLength(FINDING_HANDLE_LEN);
    expect(finding.id.length).toBeGreaterThan(FINDING_HANDLE_LEN * 4);
  });
});

describe("resolveFindingId", () => {
  it("accepts the full id the tool returned inside the same run", () => {
    const finding = note("Revenue fell twelve percent.");
    expect(resolveFindingId(PATH, finding.id)).toBe(finding.id);
  });

  it("accepts the short handle the record note printed", () => {
    const finding = note("Revenue fell twelve percent.");
    expect(resolveFindingId(PATH, findingHandle(finding.id))).toBe(finding.id);
  });

  it("refuses a prefix that matches more than one finding", () => {
    // Revising the wrong claim is worse than refusing: the record is what the
    // next run is told, so a mistake here propagates. Two real uuids never
    // share six leading characters, so the collision is staged rather than
    // waited for — the branch has to be exercised, not hoped about.
    const real = crypto.randomUUID.bind(crypto);
    let n = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(
      () => `abcdef0${n++}-0000-4000-8000-000000000000` as ReturnType<typeof real>,
    );
    try {
      note("Revenue fell twelve percent.");
      note("Costs were flat.", [2]);
    } finally {
      vi.mocked(crypto.randomUUID).mockRestore();
    }

    expect(resolveFindingId(PATH, "abcdef")).toBeNull();
    // Unambiguous one character further along, and then it resolves.
    expect(resolveFindingId(PATH, "abcdef0")).toBeNull();
    expect(resolveFindingId(PATH, "abcdef00")).toBe("abcdef00-0000-4000-8000-000000000000");
  });

  it("refuses an empty or blank id rather than picking the first finding", () => {
    note("Revenue fell twelve percent.");
    expect(resolveFindingId(PATH, "")).toBeNull();
    expect(resolveFindingId(PATH, "   ")).toBeNull();
  });

  it("refuses an id that belongs to no finding", () => {
    note("Revenue fell twelve percent.");
    expect(resolveFindingId(PATH, "ffffffff")).toBeNull();
  });
});

describe("revise_finding, given what the note printed", () => {
  const runTool = async (id: string, claim: string) => {
    const tool = createReviseFindingTool();
    return (await tool.execute!({ id, pages: [1], claim }, {
      context: { defaultDocPath: PATH },
    } as never)) as { revised: boolean; replaced?: string };
  };

  it("revises the finding the record note named", async () => {
    note("Revenue fell twelve percent.");
    // Taken out of the note itself, not computed alongside it. This is the seam
    // that was dead: if the note stops printing an id, there is nothing here to
    // hand back and the test fails rather than quietly testing a helper.
    const handle = buildRecordInstructions(PATH).match(/\[([0-9a-f-]+)\]/)?.[1];
    expect(handle, "the record note must name the finding").toBeTruthy();

    const result = await runTool(handle!, "Revenue fell eleven percent.");
    expect(result.revised).toBe(true);
    expect(result.replaced).toBe(handle);

    // And the correction is what the next question carries, not the original.
    const next = buildRecordInstructions(PATH);
    expect(next).toContain("eleven percent");
    expect(next).not.toContain("twelve percent");
  });

  it("revises nothing when the id names nothing", async () => {
    note("Revenue fell twelve percent.");
    const result = await runTool("ffffffff", "Revenue fell eleven percent.");
    expect(result.revised).toBe(false);
    expect(buildRecordInstructions(PATH)).toContain("twelve percent");
  });
});
