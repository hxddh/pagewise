import { beforeEach, describe, expect, it, vi } from "vitest";

/** The OCR cache directory: one JSON file per document fingerprint. */
const disk = new Map<string, string>();
vi.mock("../invoke-cmd", () => ({
  invokeCmd: vi.fn(async (cmd: string, args: { identity: string; json?: string }) => {
    if (cmd === "ocr_cache_read") return disk.get(args.identity) ?? null;
    if (cmd === "ocr_cache_write") disk.set(args.identity, args.json!);
    return null;
  }),
}));
vi.mock("./ocr-engine", () => ({
  recognizeCanvas: vi.fn(async (_c: unknown, _t: unknown, langs: string) => ({
    text: `read with ${langs}`,
    confidence: 90,
    items: [{ text: langs, rect: { x: 1, y: 2, width: 3, height: 4 } }],
  })),
  terminateOcr: vi.fn(async () => {}),
}));
vi.mock("../pdf", () => ({
  readAuthorizedFileBytes: vi.fn(),
  renderPageForOcr: vi.fn(async () => ({ canvas: { width: 1, height: 1 }, toPdf: (x: number, y: number) => [x, y] })),
}));
vi.mock("../doc-cache", () => ({ docCache: { get: () => ({ kind: "pdf" }) } }));

import { __resetOcrServiceForTests, configureOcr, flushOcr, ocrPage, restoreOcr } from "./ocr-service";

const PATH = "/scan.pdf";
const ID = "fnv1a64:0123456789abcdef:100";

beforeEach(() => {
  disk.clear();
  __resetOcrServiceForTests();
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("B7: switching the recognition language (16.0)", () => {
  it("keeps what each language read", async () => {
    configureOcr({ enabled: true, languages: "eng" });
    await restoreOcr(PATH, ID);
    for (const page of [1, 2, 3]) await ocrPage(PATH, page);
    await flushOcr(PATH);

    configureOcr({ enabled: true, languages: "chi_sim+eng" });
    await settle();
    await ocrPage(PATH, 1);
    await flushOcr(PATH);

    configureOcr({ enabled: true, languages: "eng" });
    await settle();
    await settle();
    const english = await restoreOcr(PATH, ID);
    expect(english.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(english.every((p) => p.text === "read with eng")).toBe(true);

    configureOcr({ enabled: true, languages: "chi_sim+eng" });
    await settle();
    expect((await restoreOcr(PATH, ID)).map((p) => p.text)).toEqual(["read with chi_sim+eng"]);
  });

  it("writes unsaved pages to their own language before switching", async () => {
    configureOcr({ enabled: true, languages: "eng" });
    await restoreOcr(PATH, ID);
    await ocrPage(PATH, 7);
    // Switched before the coalesced save ran.
    configureOcr({ enabled: true, languages: "chi_sim+eng" });
    await settle();
    configureOcr({ enabled: true, languages: "eng" });
    await settle();
    expect((await restoreOcr(PATH, ID)).map((p) => p.page)).toEqual([7]);
  });

  it("still reads a file 14.0 wrote", async () => {
    disk.set(ID, JSON.stringify({ v: 1, langs: "eng", pages: [{ p: 4, c: 88, ms: 10, t: "old", w: ["old"], b: [1, 2, 3, 4] }] }));
    configureOcr({ enabled: true, languages: "eng" });
    expect((await restoreOcr(PATH, ID)).map((p) => p.text)).toEqual(["old"]);
  });
});
