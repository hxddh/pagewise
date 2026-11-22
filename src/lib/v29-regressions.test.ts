import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTextItems = vi.hoisted(() => ({
  byPage: new Map<number, Array<{ text: string; rect: { x: number; y: number; width: number; height: number } }>>(),
}));

vi.mock("./pdf", () => ({
  pageTextItems: vi.fn(async (_path: string, page: number) => mockTextItems.byPage.get(page) ?? []),
  renderPageRegionToDataUrl: vi.fn(async () => "data:image/png;base64,AA=="),
  getPageGeometry: vi.fn(async () => ({ view: [0, 0, 612, 792], rotate: 0, width: 612, height: 792 })),
}));

vi.mock("./ocr/ocr-service", () => ({
  ocrEnabled: () => false,
  ocrPage: async () => null,
}));

import { setActiveReaderSelection, clearActiveReaderSelection } from "./active-selection";
import { coerceNumericToolInput } from "./agent-tool-repair";
import { createDocumentTools, newReadBudget } from "./agent-tools";
import { buildDocumentMapInstructions, buildViewContextInstructions } from "./agent-view-context";
import { verifiedSentences } from "./answer-sentences";
import { checkAnswer, clearCitationChecks } from "./citation-check";
import { claimSpanBefore, extractCitations, hideOpenCitation } from "./citations";
import { docCache } from "./doc-cache";
import { clearSearchFoldCache, searchDocumentPages } from "./document-search";
import { clearFindingAnchors } from "./finding-anchors";
import { forgetFindings } from "./finding-store";
import { addMark, forgetMarks } from "./mark-store";
import { buildSmartStarters } from "./smart-starters";

const DOC_PATH = "/docs/v29.pdf";
const toolCtx = { context: { defaultDocPath: DOC_PATH } } as never;

type ToolMap = Record<string, { execute: (input: unknown, options: unknown) => Promise<unknown> }>;

describe("v29.0 regressions", () => {
  beforeEach(() => {
    docCache.clear();
    clearSearchFoldCache();
    clearCitationChecks();
    clearFindingAnchors();
    forgetFindings(DOC_PATH);
    forgetMarks(DOC_PATH);
    clearActiveReaderSelection();
    mockTextItems.byPage.clear();
  });

  it("parses GB/T 9704 nested 〔YYYY〕 brackets inside citation quotes and streaming tails", () => {
    const md =
      '根据政策要求，研发费用加计扣除比例提高至100%〔p4 "依据《财政部 税务总局公告〔2024〕3号》第一条，比例提高至100%"〕。';
    const cites = extractCitations(md);
    expect(cites).toHaveLength(1);
    expect(cites[0]!.pages).toEqual([4]);
    expect(cites[0]!.quote).toBe("依据《财政部 税务总局公告〔2024〕3号》第一条，比例提高至100%");

    const span = claimSpanBefore(md, cites[0]!.index);
    expect(span).toContain("研发费用加计扣除比例提高至100%");

    // Half-streamed open citation with nested 〔2024〕 stays hidden until the outer 〕 arrives,
    // while plain prose 〔2024〕 outside a citation stays visible.
    const plain = "根据财税〔2024〕3号文件精神";
    expect(hideOpenCitation(plain)).toBe(plain);

    const streaming = '结论成立〔p4 "依据《公告〔2024〕3号》第';
    expect(hideOpenCitation(streaming)).toBe("结论成立");
  });

  it("reads multiple non-contiguous pages in one read_pdf_page call and notes unmatched labels", async () => {
    docCache.set({
      path: DOC_PATH,
      name: "v29.pdf",
      kind: "pdf",
      page_count: 5,
      totalPages: 5,
      stamp: "s1",
      pages: [1, 2, 3, 4, 5].map((p) => ({
        page: p,
        text: `Page ${p} content with enough characters to count as indexed text on sheet ${p}.`,
        needs_vision: false,
        has_table: false,
      })),
      outline: [],
      links: [],
      figures: [],
      pageLabels: ["i", "ii", "1", "2", "3"],
      annotations: [
        {
          page: 3,
          id: "a1",
          subtype: "Highlight",
          author: "Alice",
          quoted: "enough characters",
          contents: "Verify this figure",
          rect: { x: 10, y: 10, width: 50, height: 12 },
        },
      ],
    } as never);

    const t = createDocumentTools(newReadBudget()) as unknown as ToolMap;
    const batch = (await t.read_pdf_page!.execute({ pages: [1, 3, 5] }, toolCtx)) as {
      pages: number[];
      text: string;
      annotations?: Array<{ page: number; author?: string; contents: string }>;
    };
    expect(batch.pages).toEqual([1, 3, 5]);
    expect(batch.text).toContain("sheet 1");
    expect(batch.text).toContain("sheet 3");
    expect(batch.text).toContain("sheet 5");
    expect(batch.text).not.toContain("sheet 2");
    expect(batch.annotations?.[0]?.contents).toBe("Verify this figure");

    const unmatched = (await t.read_pdf_page!.execute({ page: 2, label: "A-99" }, toolCtx)) as {
      page: number;
      note?: string;
    };
    expect(unmatched.page).toBe(2);
    expect(unmatched.note).toContain("A-99");
  });

  it("supports read_section start continuation and multi-query + annotation search", async () => {
    docCache.set({
      path: DOC_PATH,
      name: "v29.pdf",
      kind: "pdf",
      page_count: 4,
      totalPages: 4,
      stamp: "s1",
      pages: [
        { page: 1, text: "Chapter 1 Intro\n" + "alpha ".repeat(500), needs_vision: false, has_table: false },
        { page: 2, text: "Section 1 continued\nRevenue reached $42M.", needs_vision: false, has_table: false },
        { page: 3, text: "Section 1 conclusion\nOperating margin was 19%.", needs_vision: false, has_table: false },
        { page: 4, text: "Chapter 2 Appendix\nDone.", needs_vision: false, has_table: false },
      ],
      outline: [
        { title: "Chapter 1 Intro", page: 1, level: 1 },
        { title: "Chapter 2 Appendix", page: 4, level: 1 },
      ],
      links: [],
      figures: [],
      annotations: [
        {
          page: 4,
          id: "n4",
          subtype: "Text",
          author: "Legal",
          contents: "Indemnification cap needs CFO sign-off",
          rect: { x: 10, y: 20, width: 20, height: 20 },
        },
      ],
    } as never);

    const t = createDocumentTools(newReadBudget()) as unknown as ToolMap;
    const cont = (await t.read_section!.execute(
      { title: "Chapter 1", start: 2 },
      toolCtx,
    )) as { startPage: number; endPage: number; text: string };
    expect(cont.startPage).toBe(2);
    expect(cont.endPage).toBe(3);
    expect(cont.text).toContain("Revenue reached $42M.");
    expect(cont.text).not.toContain("Chapter 1 Intro");

    const search = (await t.search_in_document!.execute(
      { queries: ["$42M", "Indemnification cap"] },
      toolCtx,
    )) as { hits: Array<{ page: number; snippet: string }> };
    expect(search.hits.map((h) => h.page)).toEqual([2, 4]);
    expect(search.hits[1]!.snippet).toContain("Indemnification cap");
  });

  it("verifies note_finding inline against page runs and flags unstated numbers immediately", async () => {
    docCache.set({
      path: DOC_PATH,
      name: "v29.pdf",
      kind: "pdf",
      page_count: 2,
      totalPages: 2,
      stamp: "s1",
      pages: [
        { page: 1, text: "Total contract value is $12.5 million over three years.", needs_vision: false, has_table: false },
        { page: 2, text: "Renewal requires 60 days notice.", needs_vision: false, has_table: false },
      ],
      outline: [],
      links: [],
      figures: [],
    } as never);
    mockTextItems.byPage.set(1, [
      {
        text: "Total contract value is $12.5 million over three years.",
        rect: { x: 72, y: 700, width: 300, height: 12 },
      },
    ]);

    const t = createDocumentTools(newReadBudget()) as unknown as ToolMap;
    const ok = (await t.note_finding!.execute(
      {
        claim: "The contract is worth $12.5 million.",
        pages: [1],
        evidence: "Total contract value is $12.5 million",
      },
      toolCtx,
    )) as { verification: string };
    expect(ok.verification).toBe("located");

    const badNum = (await t.note_finding!.execute(
      {
        claim: "The contract is worth $19.5 million.",
        pages: [1],
        evidence: "Total contract value is $12.5 million",
      },
      toolCtx,
    )) as { verification: string; unstated?: string[]; note?: string };
    expect(badNum.verification).toBe("mismatch");
    expect(badNum.unstated).toContain("$19.5 million");
    expect(badNum.note).toMatch(/revise_finding/i);
  });

  it("repairs p-prefixed pages, page ranges, and stringified booleans in coerceNumericToolInput", () => {
    const fixed = coerceNumericToolInput(
      JSON.stringify({
        page: "p5",
        pages: ["1-3", "p7"],
        fullPage: "true",
      }),
    );
    expect(fixed).not.toBeNull();
    expect(JSON.parse(fixed!)).toEqual({
      page: 5,
      pages: [1, 2, 3, 7],
      fullPage: true,
    });
  });

  it("injects active reader selection and viewing-page PDF annotations into agent context", () => {
    docCache.set({
      path: DOC_PATH,
      name: "v29.pdf",
      kind: "pdf",
      page_count: 3,
      totalPages: 3,
      stamp: "s1",
      pages: [
        { page: 1, text: "First page body.", needs_vision: false, has_table: false },
        { page: 2, text: "Second page body.", needs_vision: false, has_table: false },
        { page: 3, text: "Third page body.", needs_vision: false, has_table: false },
      ],
      outline: [],
      links: [],
      figures: [],
      annotations: [
        {
          page: 2,
          id: "a2",
          subtype: "StrikeOut",
          quoted: "waive late fees",
          contents: "Removed in final draft",
          rect: { x: 10, y: 10, width: 40, height: 10 },
        },
      ],
    } as never);

    setActiveReaderSelection({
      path: DOC_PATH,
      page: 2,
      text: "Section 4.2: Lessee shall maintain liability coverage.",
      kind: "text",
    });

    const viewHint = buildViewContextInstructions({
      path: DOC_PATH,
      docName: "v29.pdf",
      viewingPage: 2,
      totalPages: 3,
      userText: "Explain this clause",
      includeViewingPage: false,
    });
    expect(viewHint).toContain("currently has this passage highlighted on page 2");
    expect(viewHint).toContain("Section 4.2: Lessee shall maintain liability coverage.");

    const mapHint = buildDocumentMapInstructions(DOC_PATH, 2);
    expect(mapHint).toContain("PDF annotations on p2");
    expect(mapHint).toContain("[StrikeOut]");
    expect(mapHint).toContain("Removed in final draft");
  });

  it("generates document-aware smart starters and keeps ASCII + CJK search parity", () => {
    const doc = {
      path: DOC_PATH,
      name: "v29.pdf",
      kind: "pdf" as const,
      page_count: 6,
      totalPages: 6,
      stamp: "s1",
      pages: [],
      outline: [
        { title: "Methodology", page: 2, level: 1 },
        { title: "Results", page: 4, level: 1 },
      ],
      tablePages: [4],
      figures: [{ page: 5, rect: { x: 0, y: 0, width: 100, height: 100 } }],
    };
    addMark(DOC_PATH, {
      page: 2,
      rects: [{ x: 10, y: 10, width: 50, height: 12 }],
      text: "Highlighted assumption",
      stamp: "s1",
    });
    const t = (key: string, vars?: Record<string, string | number>) =>
      `${key}:${JSON.stringify(vars ?? {})}`;
    const starters = buildSmartStarters(doc as never, 2, 6, t);
    expect(starters).toHaveLength(3);
    expect(starters[0]).toContain("empty.starterSection");
    expect(starters[1]).toContain("empty.starterTables");
    expect(starters[2]).toContain("empty.starterMarks");

    // ASCII fast-path + CJK line-wrap search parity
    const hitsAscii = searchDocumentPages(
      [{ page: 1, text: "Fast ASCII Folding Path matches Sub-Pixel Zoom." }],
      "sub-pixel zoom",
      10,
    );
    expect(hitsAscii).toHaveLength(1);
    expect(hitsAscii[0]!.match).toBe("Sub-Pixel Zoom");

    const hitsCjk = searchDocumentPages(
      [{ page: 2, text: "第一条 违约\n责任由违约方承担。" }],
      "违约责任",
      10,
    );
    expect(hitsCjk).toHaveLength(1);
  });

  it("keeps multi-page table rows anchored to each citation's own page in verifiedSentences", async () => {
    mockTextItems.byPage.set(2, [
      { text: "2023 gross margin was 18.4% across North America.", rect: { x: 50, y: 600, width: 280, height: 12 } },
    ]);
    mockTextItems.byPage.set(5, [
      { text: "2024 gross margin rose to 24.1% across North America.", rect: { x: 50, y: 600, width: 280, height: 12 } },
    ]);

    const md = [
      "| Metric | 2023 | 2024 |",
      "|---|---|---|",
      '| Gross margin | 18.4%〔p2 "2023 gross margin was 18.4%"〕 | 24.1%〔p5 "2024 gross margin rose to 24.1%"〕 |',
    ].join("\n");

    await checkAnswer(DOC_PATH, 6, md);
    const verified = verifiedSentences(DOC_PATH, md);
    expect(verified).toHaveLength(2);
    expect(verified.map((v) => v.page)).toEqual([2, 5]);
  });

  it("reports per-page truncation and resume offsets in batch read_pdf_page calls", async () => {
    const longA = "A".repeat(1200);
    const longB = "B".repeat(900);
    docCache.set({
      path: DOC_PATH,
      name: "v29.pdf",
      kind: "pdf",
      page_count: 3,
      totalPages: 3,
      stamp: "s1",
      pages: [
        { page: 1, text: longA, needs_vision: false, has_table: false },
        { page: 2, text: "short middle page with more than twenty characters.", needs_vision: false, has_table: false },
        { page: 3, text: longB, needs_vision: false, has_table: false },
      ],
      outline: [],
      links: [],
      figures: [],
    } as never);

    const t = createDocumentTools(newReadBudget()) as unknown as ToolMap;
    const batch = (await t.read_pdf_page!.execute(
      { pages: [1, 3], maxChars: 600 },
      toolCtx,
    )) as {
      truncated: boolean;
      nextStart: number | null;
      nextOffset: number | null;
      truncatedPages?: Array<{ page: number; nextOffset: number }>;
      text: string;
    };
    expect(batch.truncated).toBe(true);
    expect(batch.nextStart).toBe(1);
    expect(batch.nextOffset).toBe(600);
    expect(batch.truncatedPages).toEqual([
      { page: 1, nextOffset: 600 },
      { page: 3, nextOffset: 600 },
    ]);
    expect(batch.text).toContain("page 1 truncated at offset 600 of 1200");
    expect(batch.text).toContain("page 3 truncated at offset 600 of 900");
  });
});
