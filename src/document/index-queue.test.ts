import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Shared, hoisted mock state (vi.mock factories run before imports).
const h = vi.hoisted(() => ({
  store: new Map<string, { kind: string; pages: { page: number; text: string }[] }>(),
  events: [] as Array<Record<string, unknown>>,
  pending: [] as Array<{ resolve: (v: string) => void; reject: (e: unknown) => void }>,
  visionMode: { current: "immediate" as "immediate" | "manual" },
  visionText: { current: "x".repeat(50) },
  visionCalls: [] as string[],
  /** Options each vision call was made with, so who pays is assertable. */
  visionOpts: [] as Array<Record<string, unknown>>,
  ocr: {
    enabled: false,
    /** page → what OCR reads there; absent pages read nothing. */
    pages: new Map<number, { text: string; confidence: number }>(),
    calls: [] as number[],
    /** path → the page the OCR queue says it is recognising (19.0). */
    current: new Map<string, number>(),
  },
}));

vi.mock("../lib/ocr/ocr-service", () => ({
  ocrEnabled: () => h.ocr.enabled,
  cachedOcrPage: (_path: string, page: number) => {
    const read = h.ocr.pages.get(page);
    return read ? { ...read, page, items: [], ms: 1 } : undefined;
  },
  ocrPage: vi.fn(async (_path: string, page: number) => {
    h.ocr.calls.push(page);
    const read = h.ocr.pages.get(page);
    return read ? { ...read, page, items: [], ms: 1 } : null;
  }),
  // The queue's visible face (19.0): what the preview's reading line reads.
  ocrQueueState: (path: string) => ({ current: h.ocr.current.get(path) ?? null, queued: 0 }),
  subscribeOcrQueue: () => () => {},
  cancelQueuedOcr: vi.fn(() => 0),
}));

vi.mock("../lib/doc-cache", () => ({
  docCache: {
    get: (path: string) => {
      const d = h.store.get(path);
      return d ? { path, name: "doc", kind: d.kind, pages: d.pages } : undefined;
    },
    getPages: (path: string) => h.store.get(path)?.pages ?? [],
    has: (path: string) => h.store.has(path),
    upsertPageText: vi.fn((path: string, page: number, text: string, source?: string) => {
      const d = h.store.get(path);
      if (!d) return;
      const ex = d.pages.find((p) => p.page === page);
      if (ex) Object.assign(ex, { text, source });
      else d.pages.push({ page, text, source } as { page: number; text: string });
    }),
    invalidateIndexedPageText: vi.fn((path: string, pages: number[]) => {
      const d = h.store.get(path);
      if (!d) return;
      const set = new Set(pages);
      for (const p of d.pages) if (set.has(p.page)) p.text = "";
    }),
  },
}));

vi.mock("../lib/pdf", () => ({
  readAuthorizedFileBytes: vi.fn(async () => new Uint8Array([1])),
  renderPageToJpegBytes: vi.fn(async () => new Uint8Array([2])),
  // The render the queue passes through; this mock replaces the renderer, not
  // the numbers — one path, 1,024/q0.80 (20.0).
  VISION_MAX_EDGE: 1_024,
  VISION_QUALITY: 0.8,
}));

vi.mock("../lib/settings", () => ({
  loadVisionSettings: vi.fn(async () => ({
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: "sk-test",
  })),
}));

vi.mock("../lib/llm", () => ({
  assertApiKeyForAgent: vi.fn((settings: { apiKey?: string }) => {
    if (!settings.apiKey) throw new Error("no key");
  }),
  formatLlmError: vi.fn(() => "vision error detail"),
}));

vi.mock("../lib/vision-api", () => ({
  generateVisionText: vi.fn(
    (_s: unknown, _p: unknown, _b: unknown, opts?: { signal?: AbortSignal }) => {
      h.visionOpts.push({ ...(opts ?? {}) });
      if (h.visionMode.current === "immediate") {
        return Promise.resolve(h.visionText.current);
      }
      return new Promise<string>((resolve, reject) => {
        h.pending.push({ resolve, reject });
        const sig = opts?.signal;
        if (sig) {
          if (sig.aborted) reject(new DOMException("Aborted", "AbortError"));
          else
            sig.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
        }
      });
    },
  ),
}));

vi.mock("../lib/index-events", () => ({
  emitPageIndex: vi.fn((e: Record<string, unknown>) => {
    h.events.push(e);
  }),
}));

vi.mock("../lib/index-store", () => ({
  rememberIndexedPage: vi.fn(),
  forgetIndexedPages: vi.fn(async () => {}),
}));

vi.mock("../lib/usage-tracker", () => ({
  recordVisionCall: vi.fn((path: string) => {
    h.visionCalls.push(path);
  }),
}));

import { docCache } from "../lib/doc-cache";
import { renderPageToJpegBytes } from "../lib/pdf";
import { forgetIndexedPages } from "../lib/index-store";
import { cancelQueuedOcr } from "../lib/ocr/ocr-service";
import { loadVisionSettings } from "../lib/settings";
import {
  cancelIndex,
  cancelReading,
  readingProgress,
  subscribeReadingProgress,
  DEFAULT_AGENT_SCAN_PAGES,
  DEFAULT_AUTO_INDEX_PAGES,
  ensurePageIndexed,
  indexWholeDocument,
  pendingIndexPages,
  reindexDocument,
  getAgentScanCap,
  getAutoIndexCap,
  indexPageInBackground,
  OCR_TRUSTED_CONFIDENCE,
  scheduleIndex,
  setAgentScanCap,
  setAutoIndexCap,
} from "./index-queue";
import type { LoadedDocument } from "../lib/types";

let counter = 0;
function uniquePath(): string {
  return `/mock/doc-${counter++}.pdf`;
}

function seed(path: string, pageCount: number, kind = "pdf"): LoadedDocument {
  h.store.set(path, {
    kind,
    pages: Array.from({ length: pageCount }, (_, i) => ({ page: i + 1, text: "" })),
  });
  return docCache.get(path) as LoadedDocument;
}

function eventsFor(path: string, page: number) {
  return h.events.filter((e) => e.path === path && e.page === page);
}

function statusesFor(path: string, page: number): string[] {
  return eventsFor(path, page).map((e) => e.status as string);
}

beforeEach(() => {
  h.store.clear();
  h.events.length = 0;
  h.pending.length = 0;
  h.visionCalls.length = 0;
  h.visionOpts.length = 0;
  h.visionMode.current = "immediate";
  h.visionText.current = "x".repeat(50);
  h.ocr.enabled = false;
  h.ocr.pages.clear();
  h.ocr.calls.length = 0;
  h.ocr.current.clear();
  vi.mocked(loadVisionSettings).mockImplementation(async () => ({
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: "sk-test",
  }) as never);
  setAutoIndexCap(DEFAULT_AUTO_INDEX_PAGES);
  setAgentScanCap(DEFAULT_AGENT_SCAN_PAGES);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("scheduleIndex", () => {
  it("indexes sparse pages via vision and writes the extracted text", async () => {
    const path = uniquePath();
    const doc = seed(path, 3);

    scheduleIndex(doc);

    await vi.waitFor(() => {
      expect(statusesFor(path, 3)).toContain("done");
    });

    for (const page of [1, 2, 3]) {
      expect(statusesFor(path, page)).toContain("done");
      const text = h.store.get(path)?.pages.find((p) => p.page === page)?.text;
      expect(text).toBe("x".repeat(50));
    }
    // An unprompted sweep is nobody's question and nobody's page view: the
    // calls are counted, the tokens are not booked to a message or a document.
    expect(h.visionOpts[0]).toMatchObject({ attributeUsage: false });
    expect(h.visionOpts[0]!.attributeToDocument).toBeUndefined();
  });
});

describe("reindexDocument (H3 — bounded invalidate)", () => {
  it("clears and rescans exactly the same page set, capped at DEFAULT_AUTO_INDEX_PAGES", async () => {
    const path = uniquePath();
    seed(path, DEFAULT_AUTO_INDEX_PAGES + 10); // 60 pages

    reindexDocument(path);

    await vi.waitFor(() => {
      const done = h.events.filter((e) => e.path === path && e.status === "done");
      expect(done.length).toBe(DEFAULT_AUTO_INDEX_PAGES);
    });

    const invalidate = docCache.invalidateIndexedPageText as unknown as {
      mock: { calls: unknown[][] };
    };
    expect(invalidate.mock.calls.length).toBe(1);
    const clearedPages = invalidate.mock.calls[0]![1] as number[];
    expect(clearedPages).toHaveLength(DEFAULT_AUTO_INDEX_PAGES);

    // The set of pages sent to vision must equal the set that was cleared.
    const render = renderPageToJpegBytes as unknown as { mock: { calls: unknown[][] } };
    const rescanned = render.mock.calls.map((c) => c[1] as number).sort((a, b) => a - b);
    expect(rescanned).toEqual([...clearedPages].sort((a, b) => a - b));
    // Pages 51..60 were never touched.
    expect(Math.max(...clearedPages)).toBe(DEFAULT_AUTO_INDEX_PAGES);
  });

  it("forgets the persisted copy of exactly the pages it rescans", async () => {
    // The other half of H3, which H3 did not close. The in-memory clear was
    // bounded to the rescan window; the persisted drop was not — it deleted the
    // whole document. Pages outside the window keep their text this session and
    // then have nothing on disk, so they are re-scanned and re-billed on the
    // next open: 150 paid pages of a 200-page scan, thrown away by changing a
    // setting.
    const path = uniquePath();
    seed(path, DEFAULT_AUTO_INDEX_PAGES + 10);

    const scheduled = reindexDocument(path);
    expect(scheduled).toBe(DEFAULT_AUTO_INDEX_PAGES);

    const forget = forgetIndexedPages as unknown as { mock: { calls: unknown[][] } };
    expect(forget.mock.calls.length).toBe(1);
    expect(forget.mock.calls[0]![0]).toBe(path);
    const forgotten = forget.mock.calls[0]![1] as number[];

    const invalidate = docCache.invalidateIndexedPageText as unknown as {
      mock: { calls: unknown[][] };
    };
    const cleared = invalidate.mock.calls[0]![1] as number[];
    expect([...forgotten].sort((a, b) => a - b)).toEqual([...cleared].sort((a, b) => a - b));
    expect(Math.max(...forgotten)).toBe(DEFAULT_AUTO_INDEX_PAGES);
  });

  it("schedules nothing, and says so, when the sweep budget is zero", async () => {
    // With scanning turned off a re-index has no window to work in, and has
    // always correctly done nothing. It returned void, so the caller could not
    // tell, and announced "Reindexing (vision rescan for up to 50 pages)…" —
    // naming a number that was neither the budget nor what happened.
    setAutoIndexCap(0);
    const path = uniquePath();
    seed(path, 10);

    expect(reindexDocument(path)).toBe(0);

    const forget = forgetIndexedPages as unknown as { mock: { calls: unknown[][] } };
    expect(forget.mock.calls.length).toBe(0);
    expect(
      (docCache.invalidateIndexedPageText as unknown as { mock: { calls: unknown[][] } })
        .mock.calls.length,
    ).toBe(0);
  });

  it("returns zero for a document that is not loaded", () => {
    expect(reindexDocument("/mock/not-open.pdf")).toBe(0);
  });
});

describe("automatic sweep budget", () => {
  it("sends no more pages to vision than the configured budget", async () => {
    setAutoIndexCap(2);
    const path = uniquePath();
    const doc = seed(path, 5);

    scheduleIndex(doc);

    await vi.waitFor(() => {
      const done = h.events.filter((e) => e.path === path && e.status === "done");
      expect(done.length).toBe(2);
    });

    // Every billed call is counted, so the budget must hold there too.
    expect(h.visionCalls.filter((p) => p === path)).toHaveLength(2);
    for (const page of [3, 4, 5]) {
      expect(h.store.get(path)?.pages.find((p) => p.page === page)?.text).toBe("");
    }
  });

  it("makes no billed call, and reads nothing it can settle, when the budget is 0", async () => {
    // The budget is the money: 0 means no page may be sent to the model. The
    // sweep still VISITS its window (that is the one thing that lets OCR keep
    // reading pages for free), but with local OCR off there is nothing it can
    // settle, so every page ends idle and no text is written.
    setAutoIndexCap(0);
    const path = uniquePath();
    const doc = seed(path, 5);

    scheduleIndex(doc);
    await vi.waitFor(() => expect(statusesFor(path, 5)).toContain("idle"));

    expect(h.visionCalls).toHaveLength(0);
    for (const page of [1, 2, 3, 4, 5]) {
      expect(h.store.get(path)?.pages.find((p) => p.page === page)?.text).toBe("");
    }
  });
});

describe("indexWholeDocument", () => {
  it("scans every page still missing text, ignoring the automatic budget", async () => {
    setAutoIndexCap(2);
    const path = uniquePath();
    seed(path, 5);

    expect(pendingIndexPages(path)).toEqual([1, 2, 3, 4, 5]);
    expect(indexWholeDocument(path)).toBe(5);

    await vi.waitFor(() => {
      const done = h.events.filter((e) => e.path === path && e.status === "done");
      expect(done.length).toBe(5);
    });
    expect(h.visionCalls.filter((p) => p === path)).toHaveLength(5);
  });

  it("reports nothing to do once every page has text", () => {
    const path = uniquePath();
    seed(path, 3);
    for (const p of h.store.get(path)!.pages) p.text = "y".repeat(50);

    expect(pendingIndexPages(path)).toEqual([]);
    expect(indexWholeDocument(path)).toBe(0);
    expect(h.visionCalls).toHaveLength(0);
  });
});

describe("generation-aware cancel/restart (H4/M4)", () => {
  it("re-runs a page when a reschedule interrupts an in-flight scan (stale inflight does not block)", async () => {
    const path = uniquePath();
    const doc = seed(path, 1);
    h.visionMode.current = "manual";

    scheduleIndex(doc); // generation 1
    await vi.waitFor(() => expect(h.pending.length).toBe(1));

    // Reschedule while page 1 is still in flight → aborts gen 1, starts gen 2.
    scheduleIndex(doc); // generation 2
    await vi.waitFor(() => expect(h.pending.length).toBe(2));

    // The superseded gen-1 scan resolves to idle (aborted), not stuck/failed.
    expect(statusesFor(path, 1)).toContain("idle");
    expect(statusesFor(path, 1)).not.toContain("failed");

    // Gen 2 completes successfully — the page is re-indexed, not skipped.
    h.pending[1]!.resolve("y".repeat(50));
    await vi.waitFor(() => {
      expect(statusesFor(path, 1)).toContain("done");
    });
    expect(h.store.get(path)?.pages[0]?.text).toBe("y".repeat(50));
  });
});

describe("cancelIndex (M5 — abort is idle, not failure)", () => {
  it("emits idle (not failed) when an in-flight scan is cancelled", async () => {
    const path = uniquePath();
    const doc = seed(path, 1);
    h.visionMode.current = "manual";

    scheduleIndex(doc);
    await vi.waitFor(() => expect(h.pending.length).toBe(1));

    cancelIndex(path);

    await vi.waitFor(() => {
      expect(statusesFor(path, 1)).toContain("idle");
    });
    expect(statusesFor(path, 1)).not.toContain("failed");
    expect(statusesFor(path, 1)).not.toContain("done");
    expect(h.store.get(path)?.pages[0]?.text).toBe("");
  });
});

describe("explicit read vs. background generation", () => {
  it("persists an explicit on-demand read even if a reindex bumps the generation mid-flight", async () => {
    const path = uniquePath();
    seed(path, 5);
    h.visionMode.current = "manual";

    // On-view/agent index of page 5 at generation 0 (its own controller, not the queue's).
    const p = ensurePageIndexed(path, 5);
    await vi.waitFor(() => expect(h.pending.length).toBe(1));

    // Bump the generation without aborting page 5's controller (e.g. a background reindex).
    cancelIndex(path);

    // The explicit read completes with good text. It must NOT be discarded just
    // because a background sweep superseded the generation — the caller (agent
    // tool / preview) asked for this specific page and needs its content, not an
    // empty result that reads as "this page has no content".
    h.pending[0]!.resolve("z".repeat(50));
    await p;

    expect(h.store.get(path)?.pages.find((pg) => pg.page === 5)?.text).toBe("z".repeat(50));
    expect(statusesFor(path, 5)).toContain("done");
  });
});

describe("agent scan allowance", () => {
  it("clamps the stored value and treats garbage as the default", () => {
    setAgentScanCap(0);
    expect(getAgentScanCap()).toBe(0);
    setAgentScanCap(12.9);
    expect(getAgentScanCap()).toBe(12);
    setAgentScanCap(-3);
    expect(getAgentScanCap()).toBe(DEFAULT_AGENT_SCAN_PAGES);
    setAgentScanCap(Number.NaN);
    expect(getAgentScanCap()).toBe(DEFAULT_AGENT_SCAN_PAGES);
  });

  it("is independent of the automatic sweep budget", () => {
    // Turning off unprompted scanning must not change what the assistant is
    // allowed to scan for a question the user actually asked.
    setAutoIndexCap(0);
    setAgentScanCap(20);
    expect(getAutoIndexCap()).toBe(0);
    expect(getAgentScanCap()).toBe(20);
  });
});

describe("local OCR first (14.0)", () => {
  const readWell = { text: "The filter admits a newcomer only if it is popular.", confidence: 92 };
  const readPoorly = { text: "Tbe fi1ter adm1ts a newc0mer on1y if it is popu1ar.", confidence: 41 };

  it("keeps a page OCR reads well, and never calls vision for it", async () => {
    h.ocr.enabled = true;
    const path = uniquePath();
    const doc = seed(path, 2);
    h.ocr.pages.set(1, readWell);
    h.ocr.pages.set(2, readWell);

    scheduleIndex(doc);
    await vi.waitFor(() => expect(statusesFor(path, 2)).toContain("done"));

    expect(h.visionCalls).toHaveLength(0);
    expect(h.store.get(path)?.pages[0]).toMatchObject({ text: readWell.text, source: "ocr" });
    expect(eventsFor(path, 1).slice(-1)[0]).toMatchObject({ status: "done", source: "ocr" });
  });

  it("reads every page when the vision budget is zero — OCR costs nothing", async () => {
    h.ocr.enabled = true;
    setAutoIndexCap(0);
    const path = uniquePath();
    const doc = seed(path, 5);
    for (let p = 1; p <= 5; p++) h.ocr.pages.set(p, readWell);

    scheduleIndex(doc);
    await vi.waitFor(() => expect(statusesFor(path, 5)).toContain("done"));
    expect(h.ocr.calls.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(h.visionCalls).toHaveLength(0);
  });

  it("offers a poorly read page to vision within the budget, and keeps OCR's text beyond it", async () => {
    h.ocr.enabled = true;
    setAutoIndexCap(1);
    const path = uniquePath();
    const doc = seed(path, 3);
    for (let p = 1; p <= 3; p++) h.ocr.pages.set(p, readPoorly);
    expect(readPoorly.confidence).toBeLessThan(OCR_TRUSTED_CONFIDENCE);

    scheduleIndex(doc);
    await vi.waitFor(() => {
      for (const p of [1, 2, 3]) expect(statusesFor(path, p)).toContain("done");
    });

    expect(h.visionCalls).toHaveLength(1);
    const sources = h.store.get(path)!.pages.map((p) => (p as { source?: string }).source).sort();
    expect(sources).toEqual(["ocr", "ocr", "vision"]);
  });

  it("goes on reading locally without an API key, and fails nothing", async () => {
    h.ocr.enabled = true;
    vi.mocked(loadVisionSettings).mockImplementation(async () => ({ provider: "openai", model: "m", apiKey: "" }) as never);
    const path = uniquePath();
    const doc = seed(path, 4);
    h.ocr.pages.set(1, readPoorly);
    h.ocr.pages.set(3, readWell);
    h.ocr.pages.set(4, readPoorly);

    scheduleIndex(doc);
    await vi.waitFor(() => expect(h.ocr.calls.length).toBe(4));
    await vi.waitFor(() => expect(statusesFor(path, 4).slice(-1)[0]).toBe("done"));

    expect(h.events.some((e) => e.status === "failed")).toBe(false);
    expect(h.store.get(path)!.pages.map((p) => p.text.length > 0)).toEqual([true, false, true, true]);
  });

  it("does not read past DEFAULT_AUTO_INDEX_PAGES, however large the cloud budget is (20.0)", async () => {
    // The page window is the CPU bound: OCR is free but 2.64s a page, and a
    // 300-page scan used to mean every page was recognised — about 6.6 minutes
    // of it. The reader's cloud preference bounds the billed CALLS, not the
    // local reading, so even "All" (200) sweeps 50 pages.
    h.ocr.enabled = true;
    setAutoIndexCap(200);
    const path = uniquePath();
    const doc = seed(path, DEFAULT_AUTO_INDEX_PAGES + 10);
    const readWell = { text: "The filter admits a newcomer only if it is popular.", confidence: 92 };
    for (let p = 1; p <= DEFAULT_AUTO_INDEX_PAGES + 10; p++) h.ocr.pages.set(p, readWell);

    scheduleIndex(doc);
    await vi.waitFor(() => expect(h.ocr.calls.length).toBe(DEFAULT_AUTO_INDEX_PAGES));
    // A beat, in case a 51st read is on its way (it is not — the window is
    // fixed before the pool starts).
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(h.ocr.calls.length).toBe(DEFAULT_AUTO_INDEX_PAGES);
    expect(h.visionCalls).toHaveLength(0);
    expect(h.store.get(path)!.pages.filter((p) => p.text.length > 0)).toHaveLength(
      DEFAULT_AUTO_INDEX_PAGES,
    );
  });

  it("lets an explicit whole-document index read past the window", async () => {
    // The other half of the cap: "Read pages with no text" is the reader's
    // own action, it shows the page count first, and it is the only way past
    // the automatic window (there is no `cap: null` sweep any more).
    h.ocr.enabled = true;
    const path = uniquePath();
    seed(path, DEFAULT_AUTO_INDEX_PAGES + 10);
    const readWell = { text: "The filter admits a newcomer only if it is popular.", confidence: 92 };
    for (let p = 1; p <= DEFAULT_AUTO_INDEX_PAGES + 10; p++) h.ocr.pages.set(p, readWell);

    expect(pendingIndexPages(path)).toHaveLength(DEFAULT_AUTO_INDEX_PAGES + 10);
    expect(indexWholeDocument(path)).toBe(DEFAULT_AUTO_INDEX_PAGES + 10);

    await vi.waitFor(() => expect(h.ocr.calls.length).toBe(DEFAULT_AUTO_INDEX_PAGES + 10));
  });

  it("does not pay to improve a page the reader is only looking at", async () => {
    h.ocr.enabled = true;
    const path = uniquePath();
    seed(path, 2);
    h.ocr.pages.set(1, readPoorly);

    indexPageInBackground(path, 1);
    await vi.waitFor(() => expect(statusesFor(path, 1)).toContain("done"));
    expect(h.visionCalls).toHaveLength(0);

    // A page OCR read nothing on still goes to vision, as before.
    indexPageInBackground(path, 2);
    await vi.waitFor(() => expect(statusesFor(path, 2)).toContain("done"));
    expect(h.visionCalls).toHaveLength(1);
    // And it is booked to the document, not dropped: no message is being
    // written, but the reader is looking at the page that was billed (18.0).
    expect(h.visionOpts[0]).toMatchObject({ attributeUsage: false, attributeToDocument: path });
  });

  it("lets an explicit read replace poorly read text with vision", async () => {
    h.ocr.enabled = true;
    const path = uniquePath();
    seed(path, 1);
    h.ocr.pages.set(1, readPoorly);

    // The agent's read path (`readPageText`) asks for "run": the message pays.
    await ensurePageIndexed(path, 1, undefined, "run");
    expect(h.visionCalls).toHaveLength(1);
    expect(h.store.get(path)!.pages[0]).toMatchObject({ source: "vision" });
    expect(h.visionOpts[0]).toMatchObject({ attributeUsage: true });
  });

  it("sends the same page render for every page, whatever OCR made of it (20.0)", async () => {
    // 18.0 lowered the page render to 1,024px q0.80; 20.0 deleted the branch
    // that sent a page OCR read poorly at 1,568 q0.85 instead. The larger
    // render is 2.0–2.2× the bytes, not the "3–4×" the comment claimed, and
    // the same model reads the page at the default size.
    h.ocr.enabled = true;
    const path = uniquePath();
    seed(path, 2);
    h.ocr.pages.set(1, readPoorly);

    await ensurePageIndexed(path, 1);
    await ensurePageIndexed(path, 2);

    const render = renderPageToJpegBytes as unknown as { mock: { calls: unknown[][] } };
    expect(render.mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([
      [1, 1_024, 0.8],
      [2, 1_024, 0.8],
    ]);
  });

  it("re-scans with vision when asked, not with OCR", async () => {
    h.ocr.enabled = true;
    const path = uniquePath();
    seed(path, 2);
    h.ocr.pages.set(1, readWell);
    h.ocr.pages.set(2, readWell);

    reindexDocument(path);
    await vi.waitFor(() => expect(statusesFor(path, 2)).toContain("done"));
    expect(h.ocr.calls).toHaveLength(0);
    expect(h.visionCalls).toHaveLength(2);
  });
});

describe("reading progress (19.0 — OCR you can watch)", () => {
  it("says nothing when nothing is being read", () => {
    const path = uniquePath();
    seed(path, 2);
    expect(readingProgress(path)).toBeNull();
  });

  it("reports the page being read and how many the pass will read", async () => {
    const path = uniquePath();
    const doc = seed(path, 3);
    h.visionMode.current = "manual";

    const notified = vi.fn();
    const unsubscribe = subscribeReadingProgress(notified);
    scheduleIndex(doc);
    await vi.waitFor(() => expect(readingProgress(path)).not.toBeNull());
    expect(readingProgress(path)).toMatchObject({ state: "reading", total: 3 });
    expect(notified).toHaveBeenCalled();

    // When OCR is the reader, the page is the one being recognised — that is
    // the page whose words are arriving.
    h.ocr.current.set(path, 2);
    expect(readingProgress(path)).toMatchObject({ state: "reading", page: 2 });

    // Finish the sweep: the calls already in flight resolve, and the pages
    // behind them are read at once rather than queued.
    h.visionMode.current = "immediate";
    h.pending.forEach((p) => p.resolve("y".repeat(50)));
    await vi.waitFor(() => expect(readingProgress(path)).toBeNull());
    unsubscribe();
  });

  it("stops both layers when the reader cancels, and says so", async () => {
    const path = uniquePath();
    const doc = seed(path, 2);
    h.visionMode.current = "manual";

    scheduleIndex(doc);
    await vi.waitFor(() => expect(h.pending.length).toBeGreaterThan(0));
    cancelReading(path);

    // The OCR queue is told separately: a page already waiting for a worker
    // cannot hear the sweep's abort signal.
    expect(cancelQueuedOcr).toHaveBeenCalledWith(path);
    // The terminal state (20.0): the line does not vanish as if nothing had
    // happened — it says the pass stopped, how much it read, and that the rest
    // waits to be read on demand.
    expect(readingProgress(path)).toMatchObject({ state: "stopped", read: 0, total: 2, left: 2 });
    await vi.waitFor(() => expect(statusesFor(path, 1)).toContain("idle"));
  });

  it("names the pages a sweep that ran into its cap leaves for on-demand reading (20.0)", async () => {
    // The page cap is the CPU bound: a 300-page scan sweeps 50. The line used
    // to disappear at the end of the window; now it says what is left — 53
    // pages in, 50 read, 3 to be read when the reader reaches them.
    h.ocr.enabled = true;
    const path = uniquePath();
    const doc = seed(path, DEFAULT_AUTO_INDEX_PAGES + 3);
    const readWell = { text: "The filter admits a newcomer only if it is popular.", confidence: 92 };
    for (let p = 1; p <= DEFAULT_AUTO_INDEX_PAGES + 3; p++) h.ocr.pages.set(p, readWell);

    scheduleIndex(doc);
    await vi.waitFor(() =>
      expect(readingProgress(path)).toMatchObject({
        state: "stopped",
        read: DEFAULT_AUTO_INDEX_PAGES,
        total: DEFAULT_AUTO_INDEX_PAGES,
        left: 3,
      }),
    );

    // The state describes one sweep, not the document: a new sweep replaces
    // it, and closing the document takes it with the queue.
    scheduleIndex(doc);
    expect(readingProgress(path)?.state).not.toBe("stopped");
    cancelIndex(path);
    expect(readingProgress(path)).toBeNull();
  });
});
