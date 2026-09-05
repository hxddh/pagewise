import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TextItemRect } from "./types";

/** What `page_text_items` answers per page: runs, an empty page, or an error. */
let pages: Record<number, TextItemRect[] | Error> = {};
vi.mock("./pdf", () => ({
  pageTextItems: async (_path: string, page: number) => {
    const answer = pages[page];
    if (answer instanceof Error) throw answer;
    return answer ?? [];
  },
}));

import { cachedPlacement, clearFindingAnchors, placeFinding } from "./finding-anchors";
import type { Finding } from "./finding-store";

const PATH = "/docs/scan.pdf";
const run = (text: string): TextItemRect => ({
  text,
  rect: { x: 72, y: 700, width: 400, height: 12 },
});
const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "f1",
  pages: [1],
  claim: "Revenue fell.",
  evidence: "revenue fell by twelve percent",
  createdAt: 1,
  stamp: "s",
  ...over,
});

beforeEach(() => {
  pages = {};
  clearFindingAnchors();
});

/**
 * The four answers a page can give about a quote — and the two that were one.
 *
 * Until 12.0 a page with no text layer and a page whose runs failed to load
 * were both an empty list, and an empty list made every quote "absent". The
 * review ran a scanned page through this and got "this wording is not on the
 * page it cites" for a citation nothing had been able to check.
 */
describe("placeFinding", () => {
  it("locates a quote on the page it cites", async () => {
    pages = { 1: [run("Revenue fell by twelve percent.")] };
    const out = await placeFinding(PATH, finding());
    expect(out.status).toBe("located");
    if (out.status !== "located") return;
    expect(out.anchor.page).toBe(1);
  });

  it("says absent only when the page has text and the quote is not in it", async () => {
    pages = { 1: [run("Costs were flat.")] };
    expect((await placeFinding(PATH, finding())).status).toBe("absent");
  });

  it("says unreadable for a page with no text layer", async () => {
    pages = { 1: [] };
    expect((await placeFinding(PATH, finding())).status).toBe("unreadable");
  });

  it("says unreadable when the runs could not be read at all", async () => {
    pages = { 1: new Error("IPC failed") };
    expect((await placeFinding(PATH, finding())).status).toBe("unreadable");
  });

  it("withholds absent when any cited page could not be checked", async () => {
    // Absent from page 1, which has text; unreadable on page 2. One page the
    // app could not look at is enough not to accuse.
    pages = { 1: [run("Costs were flat.")], 2: [] };
    expect((await placeFinding(PATH, finding({ pages: [1, 2] }))).status).toBe("unreadable");
  });

  it("says uncheckable when there is nothing to look for", async () => {
    pages = { 1: [] };
    expect((await placeFinding(PATH, finding({ evidence: "" }))).status).toBe("uncheckable");
    expect((await placeFinding(PATH, finding({ evidence: "abc" }))).status).toBe("uncheckable");
  });

  it("remembers the last placement so a synchronous caller can read it", async () => {
    expect(cachedPlacement(PATH, "f1")).toBeNull();
    pages = { 1: [run("Revenue fell by twelve percent.")] };
    await placeFinding(PATH, finding());
    expect(cachedPlacement(PATH, "f1")?.status).toBe("located");
    clearFindingAnchors(PATH);
    expect(cachedPlacement(PATH, "f1")).toBeNull();
  });

  it("does not make a transient failure permanent", async () => {
    pages = { 1: new Error("IPC failed") };
    expect((await placeFinding(PATH, finding())).status).toBe("unreadable");
    pages = { 1: [run("Revenue fell by twelve percent.")] };
    expect((await placeFinding(PATH, finding())).status).toBe("located");
  });
});
