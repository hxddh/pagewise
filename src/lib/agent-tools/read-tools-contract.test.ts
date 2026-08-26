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

import { createDocumentTools, newReadBudget } from "./index";
import type { ReadBudget } from "./reading";
import { ALREADY_READ_NOTE, DEFAULT_PAGE_MAX_CHARS } from "./reading";
import { docCache } from "../doc-cache";

const PATH = "/docs/paper.pdf";
const options = { context: { defaultDocPath: PATH } } as never;

/** Distinct, countable text per page, so an off-by-one is visible in the result. */
const pageText = (page: number, chars = 400) =>
  `PAGE-${page}-START ` + `p${page} `.repeat(Math.ceil(chars / 4)).slice(0, chars);

function loadDoc(
  pages: Array<{ page: number; text: string }>,
  pageLabels?: string[],
  annotations?: unknown[],
) {
  // Clear first. `docCache.set` MERGES page text on reload — reopening the same
  // path keeps whatever text is longer — so without this a 12,000-character
  // page from one block survives into the next and silently changes what the
  // tools under test are reading. It cost two false failures here already.
  docCache.clear();
  docCache.set({
    path: PATH,
    name: "paper.pdf",
    kind: "pdf",
    page_count: pages.length,
    totalPages: pages.length,
    stamp: "stamp-1",
    pages: pages.map((p) => ({ ...p, needs_vision: false, has_table: false })),
    outline: [],
    links: [],
    figures: [],
    pageLabels,
    annotations,
  } as never);
}

type Tool = { execute: (input: unknown, options: unknown) => Promise<never> };
type Tools = Record<string, Tool & { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }>;

function tools(budget: ReadBudget = newReadBudget()) {
  return { budget, t: createDocumentTools(budget) as never as Tools };
}

beforeEach(() => {
  loadDoc([1, 2, 3, 4, 5].map((page) => ({ page, text: pageText(page) })));
});

/**
 * What the reading tools promise the model.
 *
 * These six tools had no tests of their own: `src/lib/agent-tools/tools/` held
 * eight modules and zero test files, and `read_pdf_range` had no test naming it
 * at all. What coverage existed tested the helpers AROUND them —
 * `collectReadPages` reads a tool call's *input*, never its output — so every
 * one of the semantics below could have changed without a red test.
 *
 * They are the ones that drift silently, because a model does not complain: an
 * off-by-one in a page number reads as the assistant misunderstanding the
 * document, a broken `nextOffset` reads as a long page being mysteriously
 * incomplete, and a budget that stops refusing reads shows up on a bill.
 */
describe("read tool contract: page numbers are 1-based", () => {
  it("reads the page the model asked for, not its neighbour", async () => {
    // The single assertion an off-by-one cannot survive. Page text is stamped
    // with its own number so a shift of one is visible rather than plausible.
    const { t } = tools();
    for (const page of [1, 3, 5]) {
      const out = (await t.read_pdf_page!.execute({ page }, options)) as {
        page: number;
        text: string;
      };
      expect(out.page).toBe(page);
      expect(out.text, `page ${page} must return page ${page}'s text`).toContain(
        `PAGE-${page}-START`,
      );
    }
  });

  it("refuses page 0 at the schema", async () => {
    // Refused as a validation error the model can correct, rather than reaching
    // the reader and being silently clamped to page 1.
    const { t } = tools();
    expect(t.read_pdf_page!.inputSchema.safeParse({ page: 0 }).success).toBe(false);
    expect(t.read_pdf_page!.inputSchema.safeParse({ page: 1 }).success).toBe(true);
  });

  it("refuses a page past the end, and says how long the document is", async () => {
    // Models cite printed page numbers, which run ahead of physical ones. The
    // message has to carry the real count or the model retries the same page.
    const { t } = tools();
    await expect(t.read_pdf_page!.execute({ page: 6 }, options)).rejects.toThrow(/5 page/);
  });

  it("reads a range inclusive of both ends", async () => {
    const { t } = tools();
    const out = (await t.read_pdf_range!.execute({ start: 2, end: 4 }, options)) as {
      startPage: number;
      endPage: number;
      text: string;
    };
    expect([out.startPage, out.endPage]).toEqual([2, 4]);
    for (const page of [2, 3, 4]) expect(out.text).toContain(`PAGE-${page}-START`);
    expect(out.text, "a range must not reach past the page it was asked for").not.toContain(
      "PAGE-5-START",
    );
  });
});

describe("read tool contract: truncation is continuable", () => {
  /** One page far longer than a single read returns. */
  const LONG = 12_000;

  beforeEach(() => {
    loadDoc([
      { page: 1, text: pageText(1, LONG) },
      { page: 2, text: pageText(2) },
    ]);
  });

  it("reports exactly where it stopped, and resuming there loses nothing", async () => {
    // The whole contract in one assertion: first slice + continuation must
    // reconstruct the page byte for byte. A nextOffset off by one drops or
    // duplicates a character silently — the model reads a page with a hole in
    // it and has no way to know.
    const { t } = tools();
    const first = (await t.read_pdf_page!.execute(
      { page: 1, maxChars: 1_000 },
      options,
    )) as { text: string; truncated: boolean; nextOffset: number | null; charCount: number };

    expect(first.truncated, "a 12,000-character page cannot fit in 1,000").toBe(true);
    expect(first.charCount).toBe(1_000);
    expect(first.nextOffset, "nextOffset is where the returned text ended").toBe(1_000);

    const second = (await t.read_pdf_page!.execute(
      { page: 1, offset: first.nextOffset, maxChars: 50_000 },
      options,
    )) as { text: string; truncated: boolean; nextOffset: number | null };

    expect(first.text + second.text).toBe(pageText(1, LONG));
    expect(second.truncated).toBe(false);
    expect(second.nextOffset).toBeNull();
  });

  it("does not mark a truncated page as delivered", async () => {
    // A page cut short must stay re-readable, or a long page becomes
    // unreadable past its first slice — the dedup guard would answer every
    // continuation with "already returned in full".
    const { t } = tools();
    await t.read_pdf_page!.execute({ page: 1, maxChars: 1_000 }, options);
    const again = (await t.read_pdf_page!.execute({ page: 1, maxChars: 1_000 }, options)) as {
      text: string;
      alreadyRead?: boolean;
    };
    expect(again.alreadyRead).toBeUndefined();
    expect(again.text).not.toBe(ALREADY_READ_NOTE);
  });

  it("says a whole page is whole", async () => {
    const { t } = tools();
    const out = (await t.read_pdf_page!.execute({ page: 2 }, options)) as {
      truncated: boolean;
      nextOffset: number | null;
    };
    expect(out.truncated).toBe(false);
    expect(out.nextOffset, "nothing left to resume from").toBeNull();
  });

  it("defaults to a cap the model is told about", async () => {
    // The tool description names DEFAULT_PAGE_MAX_CHARS. If the default drifts
    // from the description the model asks for continuations it does not need,
    // or stops asking for ones it does.
    const { t } = tools();
    const out = (await t.read_pdf_page!.execute({ page: 1 }, options)) as { charCount: number };
    expect(out.charCount).toBe(DEFAULT_PAGE_MAX_CHARS);
  });
});

describe("read tool contract: a page is handed over once", () => {
  it("answers a repeat with a note instead of the text, and charges nothing", async () => {
    // The text is still a few messages above. Sending it again buys no
    // information and costs the whole page — and, for a page with no text
    // layer, a second billed vision call.
    const { budget, t } = tools();
    await t.read_pdf_page!.execute({ page: 2 }, options);
    const charged = budget.used;
    expect(charged).toBeGreaterThan(0);

    const again = (await t.read_pdf_page!.execute({ page: 2 }, options)) as {
      text: string;
      alreadyRead: boolean;
      charCount: number;
    };
    expect(again.alreadyRead).toBe(true);
    expect(again.text).toBe(ALREADY_READ_NOTE);
    expect(again.charCount).toBe(0);
    expect(budget.used, "a repeat must cost nothing").toBe(charged);
  });

  it("holds across the two readers, not just inside one", async () => {
    // 7.2 put this guard in the range reader alone and the single-page tool —
    // which has its own path — silently fell outside it. Read a range, then a
    // page inside it, and the page went over the wire twice.
    const { budget, t } = tools();
    await t.read_pdf_range!.execute({ start: 1, end: 3 }, options);
    const charged = budget.used;

    const inside = (await t.read_pdf_page!.execute({ page: 2 }, options)) as {
      alreadyRead?: boolean;
    };
    expect(inside.alreadyRead, "page 2 was already sent as part of 1-3").toBe(true);
    expect(budget.used).toBe(charged);
  });
});

describe("read tool contract: the budget refuses rather than throws", () => {
  it("reports budgetExceeded with a note the model can act on", async () => {
    // A run that hits its ceiling must still be able to answer from what it
    // read. Throwing would end the run with nothing.
    const { budget, t } = tools();
    budget.used = budget.max;

    const out = (await t.read_pdf_page!.execute({ page: 1 }, options)) as {
      text: string;
      charCount: number;
      budgetExceeded: boolean;
      note: string;
      truncated: boolean;
      nextOffset: number | null;
    };
    expect(out.budgetExceeded).toBe(true);
    expect(out.text).toBe("");
    expect(out.charCount).toBe(0);
    expect(out.truncated, "an empty refusal is not a truncated read").toBe(false);
    expect(out.nextOffset, "there is nothing to resume").toBeNull();
    expect(out.note, "the note must tell the model to stop reading").toMatch(/do not read more/i);
  });

  it("refuses a search the same way, with no hits rather than an error", async () => {
    const { budget, t } = tools();
    budget.used = budget.max;
    const out = (await t.search_in_document!.execute({ query: "p3" }, options)) as {
      hits: unknown[];
      budgetExceeded: boolean;
    };
    expect(out.budgetExceeded).toBe(true);
    expect(out.hits).toEqual([]);
  });

  it("never returns more characters than the budget had left", async () => {
    // The cap is on what reaches the context, so a page bigger than the
    // remaining allowance must come back clipped, not whole.
    loadDoc([{ page: 1, text: pageText(1, 12_000) }]);
    const { budget, t } = tools();
    budget.used = budget.max - 500;

    const out = (await t.read_pdf_page!.execute({ page: 1 }, options)) as { charCount: number };
    expect(out.charCount).toBe(500);
    expect(budget.used).toBe(budget.max);
  });
});

describe("read tool contract: a search hit says where it was found", () => {
  it("carries the page it was found on and the text around it — and nothing else", async () => {
    // A hit is `{ page, snippet }`. The internal `SearchHit` also has `index`
    // and `match`, and `document/search.ts` maps them away on purpose: every
    // hit is sent to a model and paid for, and neither field tells it anything
    // the snippet does not. The exact-shape assertion is the point — a field
    // quietly added back here costs tokens on every search in every run.
    const { t } = tools();
    const out = (await t.search_in_document!.execute({ query: "PAGE-3-START" }, options)) as {
      hits: Array<Record<string, unknown>>;
      truncated: boolean;
    };
    expect(out.hits.length).toBeGreaterThan(0);
    const hit = out.hits[0]!;
    expect(Object.keys(hit).sort()).toEqual(["page", "snippet"]);
    expect(hit.page, "hits are anchored to a 1-based page").toBe(3);
    expect(hit.snippet, "the snippet embeds the match").toContain("PAGE-3-START");
  });

  it("distinguishes 'exactly this many matches' from 'there are more'", async () => {
    // The tool probes one hit past the cap for this. Without it a model cannot
    // tell a complete result from a clipped one and stops searching too early.
    const { t } = tools();
    const exact = (await t.search_in_document!.execute(
      { query: "PAGE-1-START", maxResults: 1 },
      options,
    )) as { truncated: boolean };
    expect(exact.truncated, "one match, one asked for: nothing was left out").toBe(false);

    const more = (await t.search_in_document!.execute(
      { query: "p3", maxResults: 1 },
      options,
    )) as { hits: unknown[]; truncated: boolean };
    expect(more.hits).toHaveLength(1);
    expect(more.truncated, "page 3 repeats 'p3' many times").toBe(true);
  });
});

describe("read tool contract: an aborted run cannot spend the next one's budget", () => {
  it("charges nothing when the generation moved on mid-flight", async () => {
    // A tool promise still in flight when the reader hits stop lands AFTER
    // prepareCall has reset the budget for the next question. Without the
    // generation guard the abandoned run's pages are billed to the new one —
    // which then refuses reads it should have been allowed.
    const { budget, t } = tools();
    const inFlight = t.read_pdf_page!.execute({ page: 1 }, options);

    // The run is abandoned and the next one begins before the read resolves.
    budget.gen += 1;
    const before = budget.used;
    await inFlight;

    expect(budget.used, "a stale run's read must not be charged").toBe(before);
  });

  it("still charges a read that belongs to the current run", async () => {
    // The other half: a guard that refuses everything would pass the test above
    // and make the budget meaningless.
    const { budget, t } = tools();
    await t.read_pdf_page!.execute({ page: 1 }, options);
    expect(budget.used).toBeGreaterThan(0);
  });
});

/**
 * Printed page numbers reaching the tool that reads pages.
 *
 * `page-labels.ts` unit-tests the resolution. This is the WIRING, and the
 * wiring is the part this project keeps finding dead: a page citation that
 * rendered nowhere, a per-send context that was built and thrown away, a
 * mark drawn through the wrong conversion. All three type-checked and all
 * three had passing tests on either side of the seam.
 */
describe("read tool contract: a page can be asked for by its printed number", () => {
  /** Front matter in roman, then the body restarts at 1 on sheet 3. */
  const LABELS = ["i", "ii", "1", "2", "3"];

  beforeEach(() => {
    loadDoc([1, 2, 3, 4, 5].map((page) => ({ page, text: pageText(page) })), LABELS);
  });

  it("reads the sheet a printed number is printed on, not the nth sheet", () => {
    // The whole feature in one assertion. The reader says "page 1" meaning the
    // body's first page; that is sheet 3.
    return tools()
      .t.read_pdf_page!.execute({ page: 1, label: "1" }, options)
      .then((out) => {
        const r = out as never as { page: number; text: string };
        expect(r.page).toBe(3);
        expect(r.text).toContain("PAGE-3-START");
      });
  });

  it("ignores case and punctuation, as a reader types them", async () => {
    const { t } = tools();
    const r = (await t.read_pdf_page!.execute({ page: 1, label: "II" }, options)) as {
      page: number;
    };
    expect(r.page).toBe(2);
  });

  it("falls back to the position when the label resolves to nothing", async () => {
    // The model may pass a label for a document that prints none, or one that
    // prints it on several pages. Reading the page it also asked for is a
    // better answer than failing the call.
    const { t } = tools();
    const missing = (await t.read_pdf_page!.execute({ page: 4, label: "zzz" }, options)) as {
      page: number;
    };
    expect(missing.page).toBe(4);

    loadDoc([1, 2, 3].map((page) => ({ page, text: pageText(page) })));
    const noLabels = (await tools().t.read_pdf_page!.execute(
      { page: 2, label: "1" },
      options,
    )) as { page: number };
    expect(noLabels.page).toBe(2);
  });

  it("reports what the page is printed as, so an answer can cite it", async () => {
    const { t } = tools();
    const r = (await t.read_pdf_page!.execute({ page: 2 }, options)) as { printedAs?: string };
    expect(r.printedAs).toBe("ii");
  });

  it("says nothing extra for a page printed as its own number", async () => {
    // Sheet 5 is printed "3"... which differs, so it does report. Sheet 4 of a
    // plainly-numbered document must not: every field here is paid for.
    loadDoc([1, 2, 3].map((page) => ({ page, text: pageText(page) })));
    const { t } = tools();
    const r = (await t.read_pdf_page!.execute({ page: 2 }, options)) as { printedAs?: string };
    expect(r.printedAs).toBeUndefined();
  });
});

/**
 * The notes already on the document reaching the model.
 *
 * `pdf-annotations.ts` unit-tests the extraction against objects copied from a
 * real pdf.js dump. This is the WIRING — that they reach the survey's output at
 * all, and that they cost nothing when a document has none.
 */
describe("read tool contract: notes already written on the document", () => {
  const NOTE = {
    page: 2,
    id: "6R",
    subtype: "Highlight",
    contents: "Is eight weeks long enough?",
    author: "Reviewer A",
    quoted: "The trial ran for eight weeks.",
    rect: { x: 38, y: 714, width: 382, height: 20 },
  };

  it("carries them in the survey, with the page, the author and the words", async () => {
    loadDoc([1, 2, 3].map((page) => ({ page, text: pageText(page) })), undefined, [NOTE]);
    const { t } = tools();
    const out = (await t.document_outline!.execute({}, options)) as {
      notesInDocument?: string[];
    };
    expect(out.notesInDocument).toBeDefined();
    expect(out.notesInDocument!.join("\n")).toContain("p2");
    expect(out.notesInDocument!.join("\n")).toContain("Reviewer A");
    expect(out.notesInDocument!.join("\n")).toContain("Is eight weeks long enough?");
    expect(out.notesInDocument!.join("\n")).toContain("The trial ran for eight weeks");
  });

  it("says nothing at all about a document nobody has written on", async () => {
    // The overwhelming majority. Every field in this result is paid for on the
    // request that carries it.
    loadDoc([1, 2, 3].map((page) => ({ page, text: pageText(page) })));
    const { t } = tools();
    const out = (await t.document_outline!.execute({}, options)) as {
      notesInDocument?: string[];
      notesOmitted?: number;
    };
    expect(out.notesInDocument).toBeUndefined();
    expect(out.notesOmitted).toBeUndefined();
  });

  it("says how many it left out rather than pretending the list is whole", async () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      ...NOTE,
      id: `n${i}`,
      contents: `A comment long enough to matter, number ${i}, on this document.`,
    }));
    loadDoc([1, 2, 3].map((page) => ({ page, text: pageText(page) })), undefined, many);
    const { t } = tools();
    const out = (await t.document_outline!.execute({}, options)) as {
      notesInDocument?: string[];
      notesOmitted?: number;
    };
    expect(out.notesOmitted).toBeGreaterThan(0);
    expect(out.notesInDocument!.length + out.notesOmitted!).toBe(400);
  });
});
