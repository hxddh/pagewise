import { beforeEach, describe, expect, it, vi } from "vitest";

/** The OCR cache directory: one JSON file per document fingerprint. */
const disk = new Map<string, string>();
/** Whether `ocr_cache_read` answers or fails. */
let reads: "ok" | "fail" = "ok";
vi.mock("../invoke-cmd", () => ({
  invokeCmd: vi.fn(async (cmd: string, args: { identity: string; json?: string }) => {
    if (cmd === "ocr_cache_read" && reads === "fail") throw new Error("read failed");
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
  terminateOcrSlot: vi.fn(async () => {}),
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
  reads = "ok";
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

describe("B9: a page that hangs (16.0)", () => {
  it("restarts only its own slot's worker", async () => {
    const engine = await import("./ocr-engine");
    const recognize = vi.mocked(engine.recognizeCanvas);
    vi.useFakeTimers();
    try {
      configureOcr({ enabled: true, languages: "eng" });
      await restoreOcr(PATH, ID);
      let calls = 0;
      recognize.mockImplementation(async () => {
        calls += 1;
        if (calls === 1) return new Promise(() => {});
        return { text: "ok", confidence: 90, items: [] };
      });
      const hung = ocrPage(PATH, 1);
      const fine = ocrPage(PATH, 2);
      await vi.advanceTimersByTimeAsync(10);
      expect((await fine)?.text).toBe("ok");
      await vi.advanceTimersByTimeAsync(90_000);
      expect(await hung).toBeNull();
      expect(vi.mocked(engine.terminateOcrSlot)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(engine.terminateOcr)).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the document chooses its models (22.0)", () => {
  // English-only on a Chinese scan reads garbage at confidence ~17; both
  // models read it. A page like that switches the document.
  const engine = () => import("./ocr-engine");

  it("reads a low-confidence page again with both models, and keeps them for the document", async () => {
    const recognize = vi.mocked((await engine()).recognizeCanvas);
    recognize.mockImplementation(async (_c, _t, langs) =>
      langs === "eng"
        ? { text: "l| 7 ;: garbage read by the English model", confidence: 17, items: [] }
        : { text: "质保期为三十六个月", confidence: 88, items: [] },
    );
    configureOcr({ enabled: true, languages: "eng" });
    await restoreOcr(PATH, ID);
    expect((await ocrPage(PATH, 1))?.text).toBe("质保期为三十六个月");
    recognize.mockClear();
    await ocrPage(PATH, 2);
    expect(recognize.mock.calls.map((c) => c[2]), "page 2 goes straight to both").toEqual(["chi_sim+eng"]);
  });

  it("remembers the switch when the document is opened again", async () => {
    const recognize = vi.mocked((await engine()).recognizeCanvas);
    recognize.mockImplementation(async (_c, _t, langs) =>
      langs === "eng"
        ? { text: "l| 7 ;: garbage read by the English model", confidence: 17, items: [] }
        : { text: "质保期为三十六个月", confidence: 88, items: [] },
    );
    configureOcr({ enabled: true, languages: "eng" });
    await restoreOcr(PATH, ID);
    await ocrPage(PATH, 1);
    await flushOcr(PATH);
    __resetOcrServiceForTests();
    configureOcr({ enabled: true, languages: "eng" });
    expect((await restoreOcr(PATH, ID)).map((p) => p.text)).toEqual(["质保期为三十六个月"]);
  });

  it("leaves an English page alone, and stops probing a document where both models do not help", async () => {
    const recognize = vi.mocked((await engine()).recognizeCanvas);
    recognize.mockImplementation(async () => ({ text: "a faint photo caption, hard to read", confidence: 30, items: [] }));
    configureOcr({ enabled: true, languages: "eng" });
    await restoreOcr(PATH, ID);
    for (const page of [1, 2, 3, 4]) await ocrPage(PATH, page);
    const both = recognize.mock.calls.filter((c) => c[2] === "chi_sim+eng").length;
    expect(both, "two probes, then English alone").toBe(2);

    recognize.mockClear();
    recognize.mockImplementation(async () => ({ text: "The trial ran for eight weeks.", confidence: 92, items: [] }));
    await ocrPage(PATH, 9);
    expect(recognize.mock.calls.map((c) => c[2])).toEqual(["eng"]);
  });
});

describe("a cache read that fails (22.0)", () => {
  it("does not write over the other language's pages", async () => {
    const { invokeCmd } = await import("../invoke-cmd");
    configureOcr({ enabled: true, languages: "chi_sim+eng" });
    await restoreOcr(PATH, ID);
    await ocrPage(PATH, 1);
    await flushOcr(PATH);
    const before = disk.get(ID);
    configureOcr({ enabled: true, languages: "eng" });
    await settle();
    await restoreOcr(PATH, ID);
    vi.mocked(invokeCmd).mockImplementationOnce(async () => {
      throw new Error("read failed");
    });
    await ocrPage(PATH, 2);
    await flushOcr(PATH);
    expect(JSON.parse(disk.get(ID)!)).toEqual(JSON.parse(before!));
  });
});

describe("the second reading is a try (Codex on #157)", () => {
  const ENGLISH = { text: "l| 7 ;: garbage read by the English model", confidence: 17, items: [] };

  it("keeps the English reading when both models fail", async () => {
    const recognize = vi.mocked((await import("./ocr-engine")).recognizeCanvas);
    recognize.mockImplementation(async (_c, _t, langs) => {
      if (langs === "eng") return ENGLISH;
      throw new Error("chi_sim model missing");
    });
    configureOcr({ enabled: true, languages: "eng" });
    await restoreOcr(PATH, ID);
    expect((await ocrPage(PATH, 1))?.text).toBe(ENGLISH.text);
  });

  it("keeps the English reading when both models run out of time, and restarts that worker", async () => {
    const engine = await import("./ocr-engine");
    const recognize = vi.mocked(engine.recognizeCanvas);
    vi.mocked(engine.terminateOcrSlot).mockClear();
    vi.useFakeTimers();
    try {
      recognize.mockImplementation(async (_c, _t, langs) => (langs === "eng" ? ENGLISH : new Promise(() => {})));
      configureOcr({ enabled: true, languages: "eng" });
      await restoreOcr(PATH, ID);
      const read = ocrPage(PATH, 1);
      await vi.advanceTimersByTimeAsync(90_000 + 10);
      expect((await read)?.text).toBe(ENGLISH.text);
      expect(vi.mocked(engine.terminateOcrSlot)).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a language change whose save fails (Codex on #157)", () => {
  /** Every cache read fails while `switchTo` runs and settles; the restore's read with it. */
  const switchFailing = async (languages: "eng" | "chi_sim+eng") => {
    reads = "fail";
    configureOcr({ enabled: true, languages });
    await settle();
    await settle();
    reads = "ok";
  };

  it("keeps the pages, and writes them at the next flush", async () => {
    vi.mocked((await import("./ocr-engine")).recognizeCanvas).mockImplementation(async (_c, _t, langs) => ({
      text: `read with ${langs}`,
      confidence: 90,
      items: [],
    }));
    configureOcr({ enabled: true, languages: "eng" });
    await restoreOcr(PATH, ID);
    await ocrPage(PATH, 7);
    await switchFailing("chi_sim+eng");
    expect(disk.get(ID), "the save failed").toBeUndefined();

    await flushOcr(PATH);
    configureOcr({ enabled: true, languages: "eng" });
    await settle();
    expect((await restoreOcr(PATH, ID)).map((p) => p.page)).toEqual([7]);
  });

  it("joins them to the flush when the document is back on those models", async () => {
    configureOcr({ enabled: true, languages: "eng" });
    await restoreOcr(PATH, ID);
    await ocrPage(PATH, 7);
    await switchFailing("chi_sim+eng");
    configureOcr({ enabled: true, languages: "eng" });
    await settle();
    await flushOcr(PATH);
    __resetOcrServiceForTests();
    configureOcr({ enabled: true, languages: "eng" });
    expect((await restoreOcr(PATH, ID)).map((p) => p.page)).toEqual([7]);
  });
});
