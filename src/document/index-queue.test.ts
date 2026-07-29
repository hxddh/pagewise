import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Shared, hoisted mock state (vi.mock factories run before imports).
const h = vi.hoisted(() => ({
  store: new Map<string, { kind: string; pages: { page: number; text: string }[] }>(),
  events: [] as Array<Record<string, unknown>>,
  pending: [] as Array<{ resolve: (v: string) => void; reject: (e: unknown) => void }>,
  visionMode: { current: "immediate" as "immediate" | "manual" },
  visionText: { current: "x".repeat(50) },
  visionCalls: [] as string[],
}));

vi.mock("../lib/doc-cache", () => ({
  docCache: {
    get: (path: string) => {
      const d = h.store.get(path);
      return d ? { path, name: "doc", kind: d.kind, pages: d.pages } : undefined;
    },
    getPages: (path: string) => h.store.get(path)?.pages ?? [],
    has: (path: string) => h.store.has(path),
    upsertPageText: vi.fn((path: string, page: number, text: string) => {
      const d = h.store.get(path);
      if (!d) return;
      const ex = d.pages.find((p) => p.page === page);
      if (ex) ex.text = text;
      else d.pages.push({ page, text });
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
}));

vi.mock("../lib/settings", () => ({
  loadVisionSettings: vi.fn(async () => ({
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: "sk-test",
  })),
}));

vi.mock("../lib/llm", () => ({
  assertApiKeyForAgent: vi.fn(),
  formatLlmError: vi.fn(() => "vision error detail"),
}));

vi.mock("../lib/vision-api", () => ({
  generateVisionText: vi.fn(
    (_s: unknown, _p: unknown, _b: unknown, opts?: { signal?: AbortSignal }) => {
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
  forgetIndexedDoc: vi.fn(async () => {}),
}));

vi.mock("../lib/usage-tracker", () => ({
  recordVisionCall: vi.fn((path: string) => {
    h.visionCalls.push(path);
  }),
}));

import { docCache } from "../lib/doc-cache";
import { renderPageToJpegBytes } from "../lib/pdf";
import {
  cancelIndex,
  DEFAULT_AGENT_SCAN_PAGES,
  DEFAULT_AUTO_INDEX_PAGES,
  ensurePageIndexed,
  indexWholeDocument,
  pendingIndexPages,
  reindexDocument,
  getAgentScanCap,
  getAutoIndexCap,
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
  h.visionMode.current = "immediate";
  h.visionText.current = "x".repeat(50);
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

  it("spends nothing when the budget is 0", async () => {
    setAutoIndexCap(0);
    const path = uniquePath();
    const doc = seed(path, 5);

    scheduleIndex(doc);
    // Let any scheduled work start before asserting it never did.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(h.visionCalls).toHaveLength(0);
    expect(h.events.filter((e) => e.path === path)).toHaveLength(0);
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
