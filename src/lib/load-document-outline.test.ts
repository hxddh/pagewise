import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The three sources, and who sees which.
 *
 * `preferAuthoredOutline`'s own comment insisted every consumer apply the same
 * rule, "a model shown bookmark titles and answered against synthesized ones is
 * told its own quote does not exist" — and then they did not. `reading.ts`
 * called the arbiter; the outline sidebar and the chat panel read the
 * synthesized list straight off the document. So on any PDF carrying bookmarks
 * the reader and the model were looking at different section names, which is
 * the exact failure that comment was written about.
 *
 * A rule remembered in four places is not a rule. It is resolved once now, at
 * load, and this pins the resolution AND that the resolved list is what lands
 * on the document — which is the field every consumer reads.
 */

const model = {
  page_count: 3,
  title: null,
  pages: [1, 2, 3].map((page) => ({ page, text: `page ${page}`, needs_vision: false, has_table: false })),
  outline: [{ title: "Guessed From Font Sizes", page: 1, level: 1 }],
  structure_outline: [{ title: "Tagged In The Document", page: 2, level: 1 }],
  links: [],
  figures: [],
};

let bookmarks: Array<{ title: string; page: number | null; level: number }> = [];
let structure = model.structure_outline;

vi.mock("./pdf", () => ({
  openDocument: async () => ({ ...model, structure_outline: structure }),
  getPdfOutline: async () => bookmarks,
  getPdfPageLabels: async () => null,
  getPdfAnnotations: async () => [],
}));
vi.mock("./fs-access", () => ({ allowPath: async () => {} }));
vi.mock("./file-stamp", () => ({ fileStamp: async () => "" }));
vi.mock("./index-store", () => ({ loadIndexedPages: async () => [] }));
vi.mock("../document/index-queue", () => ({ scheduleIndex: () => {} }));

const { loadDocument } = await import("./load-document");
const { docCache } = await import("./doc-cache");

const open = async () => {
  docCache.clear();
  return loadDocument("/docs/paper.pdf");
};

beforeEach(() => {
  bookmarks = [];
  structure = model.structure_outline;
});

describe("the outline that reaches the document", () => {
  it("is the author's bookmarks when the PDF carries them", async () => {
    bookmarks = [{ title: "Chapter One", page: 1, level: 1 }];
    const doc = await open();
    expect(doc.outline?.map((h) => h.title)).toEqual(["Chapter One"]);
  });

  it("is the document's tagged headings when it has no bookmarks", async () => {
    // Unlocked by the 9.3 engine upgrade. Before it, this document had nothing
    // but the font-size guess.
    const doc = await open();
    expect(doc.outline?.map((h) => h.title)).toEqual(["Tagged In The Document"]);
  });

  it("falls back to the recovered headings when the document says nothing", async () => {
    structure = [];
    const doc = await open();
    expect(doc.outline?.map((h) => h.title)).toEqual(["Guessed From Font Sizes"]);
  });

  it("gives the reader and the model the same list", async () => {
    // The divergence itself. `resolveOutline` is what the agent's
    // `document_outline` and `read_section` resolve against; `doc.outline` is
    // what the sidebar renders. They were different lists on exactly the
    // well-structured documents where bookmarks exist.
    bookmarks = [{ title: "Chapter One", page: 1, level: 1 }];
    const doc = await open();
    const { resolveOutline } = await import("./agent-tools/reading");
    const { usableOutline } = await import("./outline-nav");

    expect(resolveOutline(doc)).toEqual(usableOutline(doc.outline, doc.totalPages));
    expect(resolveOutline(doc).map((h) => h.title)).toEqual(["Chapter One"]);
  });

  it("drops a bookmark that resolves to no page rather than carrying it", async () => {
    // pdf.js reports a bookmark whose destination it could not resolve with a
    // null page. Rendering it gives the reader a row that navigates nowhere.
    bookmarks = [
      { title: "Unresolvable", page: null, level: 1 },
      { title: "Chapter One", page: 2, level: 1 },
    ];
    const doc = await open();
    expect(doc.outline?.map((h) => h.title)).toEqual(["Chapter One"]);
  });
});
