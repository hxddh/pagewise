import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDocumentTools, newReadBudget, type ReadBudget } from "./index";
import { ALREADY_READ_NOTE } from "./reading";
import { docCache } from "../doc-cache";
import { __resetMarkStoreForTests } from "../mark-store";

const PATH = "/tmp/runs.pdf";
const PAGE_TEXT = (n: number) => `PAGE-${n}-START ${"lorem ipsum ".repeat(200)}PAGE-${n}-END`;

type ToolMap = ReturnType<typeof createDocumentTools>;
async function call(tools: ToolMap, name: keyof ToolMap, input: Record<string, unknown>) {
  const tool = tools[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> };
  return (await tool.execute(input, { context: { defaultDocPath: PATH } })) as Record<string, unknown>;
}

/** What the agent does at the start of every run (`prepareCall`). */
function beginRun(budget: ReadBudget) {
  budget.used = 0;
  budget.scans = 0;
  budget.gen += 1;
  budget.delivered.clear();
}

let budget: ReadBudget;
let tools: ToolMap;
beforeEach(() => {
  __resetMarkStoreForTests();
  docCache.set({
    path: PATH,
    name: "runs.pdf",
    kind: "pdf",
    totalPages: 3,
    pages: [1, 2, 3].map((page) => ({ page, text: PAGE_TEXT(page) })),
  });
  budget = newReadBudget();
  tools = createDocumentTools(budget);
});
afterEach(() => docCache.clear());

describe("B13: a stopped run's read lands after the next run began (16.0)", () => {
  it("does not tell the new run it already has that page", async () => {
    beginRun(budget);
    const stale = call(tools, "read_pdf_page", { page: 2 });
    // Stop, and ask again at once: the next run begins before the read lands.
    beginRun(budget);
    await stale;
    const fresh = await call(tools, "read_pdf_page", { page: 2 });
    expect(fresh.alreadyRead).toBeUndefined();
    expect(String(fresh.text)).toContain("PAGE-2-START");
  });
});

describe("B14: a range that does not fit sends an already-read page again (16.0)", () => {
  it("points at the page instead", async () => {
    beginRun(budget);
    await call(tools, "read_pdf_page", { page: 2 });
    const pageLen = PAGE_TEXT(2).length;
    // Room for page 1 and a little: page 2 would not fit whole.
    const range = await call(tools, "read_pdf_range", { start: 1, end: 3, maxChars: pageLen + 400 });
    expect(String(range.text)).not.toContain("PAGE-2-START");
    expect(String(range.text)).toContain(ALREADY_READ_NOTE);
  });
});
