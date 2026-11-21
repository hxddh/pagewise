// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const getDocumentMock = vi.fn();
const invokeMock = vi.fn();

vi.mock("./runtime", () => ({
  isTauriRuntime: () => true,
}));

vi.mock("./pdf-loader", () => ({
  getPdfJs: async () => ({
    getDocument: getDocumentMock,
    TextLayer: class {
      render() {
        return Promise.resolve();
      }
      cancel() {}
    },
  }),
  pdfCMapUrl: () => "/cmaps/",
  pdfStandardFontUrl: () => "/fonts/",
  pdfWasmUrl: () => "/wasm/",
  pdfIccUrl: () => "/iccs/",
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  convertFileSrc: (p: string) => `asset://${p}`,
}));

import {
  __resetPdfForTests,
  clearPdfCache,
  disposeDocumentResources,
  getPdfAnnotations,
  getPdfOutline,
  getPdfPageLabels,
  loadPdfDocument,
  preparePdfSwitch,
  setActivePdfPath,
} from "./pdf";

function fakeDoc(opts: {
  title: string;
  labels: string[];
  note: string;
  destroySpy: () => void;
}) {
  return {
    numPages: opts.labels.length,
    loadingTask: { destroy: opts.destroySpy },
    getOutline: async () => [{ title: opts.title, dest: [{ num: 1, gen: 0 }, { name: "XYZ" }], items: [] }],
    getPageIndex: async () => 0,
    getPageLabels: async () => opts.labels,
    getPage: async (p: number) => ({
      getAnnotations: async () =>
        p === 1
          ? [
              {
                id: "note-1",
                subtype: "Text",
                contentsObj: { str: opts.note, dir: "ltr" },
                titleObj: { str: "Reviewer", dir: "ltr" },
                rect: [10, 20, 40, 50],
              },
            ]
          : [],
      cleanup: () => {},
    }),
  };
}

describe("pdf document lifecycle across A → B switches (B-01)", () => {
  afterEach(() => {
    __resetPdfForTests();
    getDocumentMock.mockReset();
    invokeMock.mockReset();
  });

  it("preserves B's outline, pageLabels, and annotations with 1 parse when switching while A is active", async () => {
    const destroyA = vi.fn();
    const destroyB = vi.fn();

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "read_file_bytes") return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
      return null;
    });

    let callsForB = 0;
    getDocumentMock.mockImplementation(() => {
      const callIdx = getDocumentMock.mock.calls.length;
      if (callIdx === 1) {
        return {
          promise: Promise.resolve(
            fakeDoc({ title: "Doc A", labels: ["1", "2"], note: "Note A", destroySpy: destroyA }),
          ),
        };
      }
      callsForB += 1;
      return {
        promise: Promise.resolve(
          fakeDoc({
            title: "Doc B Chapter 1",
            labels: ["i", "ii", "1"],
            note: "Note B",
            destroySpy: destroyB,
          }),
        ),
      };
    });

    // 1. Open A and mark A active (PreviewPane mounted on A).
    setActivePdfPath("/docs/a.pdf");
    await loadPdfDocument("/docs/a.pdf");

    // 2. Switch to B: loadDocument(B) stages B BEFORE scopeRef.dispose() tears down A!
    preparePdfSwitch("/docs/b.pdf");
    const [outlineB, labelsB, annotsB] = await Promise.all([
      getPdfOutline("/docs/b.pdf"),
      getPdfPageLabels("/docs/b.pdf", 3),
      getPdfAnnotations("/docs/b.pdf", 3),
    ]);

    expect(outlineB).toEqual([{ title: "Doc B Chapter 1", page: 1, level: 0 }]);
    expect(labelsB).toEqual(["i", "ii", "1"]);
    expect(annotsB).toHaveLength(1);
    expect(annotsB[0]!.contents).toBe("Note B");

    // 3. Dispose A's scope (`clearPdfCache()` with no args) and activate B.
    clearPdfCache();
    setActivePdfPath("/docs/b.pdf");
    await loadPdfDocument("/docs/b.pdf");

    expect(destroyA).toHaveBeenCalledTimes(1);
    expect(destroyB).not.toHaveBeenCalled();
    expect(callsForB).toBe(1);
  });

  it("invokes close_document_cmd for A while preserving staged B on document-scope teardown", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "read_file_bytes") return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
      return null;
    });
    getDocumentMock.mockImplementation(() => ({
      promise: Promise.resolve(
        fakeDoc({ title: "Doc", labels: ["1"], note: "", destroySpy: () => {} }),
      ),
    }));

    setActivePdfPath("/docs/unlocked-a.pdf");
    await loadPdfDocument("/docs/unlocked-a.pdf");

    // Stage B, then run scope teardown for A (`disposeDocumentResources(undefined, "/docs/unlocked-a.pdf")`).
    preparePdfSwitch("/docs/b.pdf");
    await loadPdfDocument("/docs/b.pdf");
    disposeDocumentResources(undefined, "/docs/unlocked-a.pdf");

    const closeCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "close_document_cmd");
    expect(closeCalls).toEqual([["close_document_cmd", { path: "/docs/unlocked-a.pdf" }]]);
  });
});
