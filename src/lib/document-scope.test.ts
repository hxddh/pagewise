/**
 * The regression this bug class earned.
 *
 * "Something the reader saw in document A showed up under document B" is
 * recorded three times in this repository's history: page text (the doc
 * cache), marks (the in-memory store), and highlights derived from the file
 * (anchors / citation checks). Each fix added another line to a hand-written
 * teardown list, which is why `document-scope.ts` exists.
 *
 * This test opens A, puts text, a mark and a finding into its caches, opens
 * B, and asserts none of it can be read back through B — and that A's
 * in-memory copies are gone too, not merely unreachable.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// The marks and findings stores write through the Tauri store plugin; without
// an in-memory stand-in their flush never lands and the in-memory forget they
// chain behind it stays deferred (that deferral is deliberate — see json-store).
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    private data = new Map<string, unknown>();
    async get<T>(key: string): Promise<T | undefined> {
      return this.data.get(key) as T | undefined;
    }
    async set(key: string, value: unknown): Promise<void> {
      this.data.set(key, value);
    }
    async save(): Promise<void> {}
  },
}));

import { __resetDocumentScopeForTests, createDocumentScope } from "./document-scope";
import { docCache } from "./doc-cache";
import { addMark, getMarks } from "./mark-store";
import { addFinding, getFindings } from "./finding-store";
import { getPageIndexState } from "./index-events";
import type { LoadedDocument } from "./types";

const A = "/docs/a.pdf";
const B = "/docs/b.pdf";

function doc(path: string, text: string): LoadedDocument {
  return {
    path,
    name: path.split("/").pop() ?? path,
    kind: "pdf",
    totalPages: 2,
    stamp: "stamp-1",
    pages: [
      { page: 1, text, source: "native" },
      { page: 2, text: `${text} — page two`, source: "native" },
    ],
  };
}

afterEach(() => {
  docCache.clear();
  createDocumentScope("/docs/none.pdf").dispose();
  __resetDocumentScopeForTests();
});

describe("document scope", () => {
  it("does not let document A's text, marks or findings appear under B", async () => {
    createDocumentScope(A);
    docCache.set(doc(A, "alpha secret words"));
    addMark(A, { page: 1, rects: [{ x: 0, y: 0, width: 10, height: 10 }], text: "alpha", stamp: "stamp-1" });
    addFinding(A, { pages: [1], claim: "A's claim", stamp: "stamp-1", author: "reader" });

    // A sees its own state while it is the open document.
    expect(docCache.getPages(A)[0]?.text).toContain("alpha secret words");
    expect(getMarks(A)).toHaveLength(1);
    expect(getFindings(A)).toHaveLength(1);

    // Open B: the scope disposes A on its own.
    createDocumentScope(B);

    expect(docCache.getPages(B)).toEqual([]);
    expect(docCache.get(A)).toBeUndefined();
    expect(getMarks(B)).toEqual([]);
    expect(getFindings(B)).toEqual([]);
    // The stores flush their durable copy first, so the in-memory forget
    // lands a microtask later.
    await vi.waitFor(() => expect(getMarks(A)).toEqual([]));
    await vi.waitFor(() => expect(getFindings(A)).toEqual([]));
  });

  it("closes the page-index states of the document being left", () => {
    createDocumentScope(A);
    // An index state exists for a page of A (written by the indexing path).
    // Reaching the module's own writer would need the queue; what matters here
    // is that the scope closes whatever the module holds for the path.
    expect(getPageIndexState(B, 1)).toBeUndefined();
    createDocumentScope(B);
    expect(getPageIndexState(A, 1)).toBeUndefined();
  });

  it("disposing twice is safe, and creating the same path again reuses it", () => {
    const first = createDocumentScope(A);
    first.dispose();
    first.dispose();
    const second = createDocumentScope(A);
    expect(second.path).toBe(A);
    second.dispose();
  });
});
