import { describe, expect, it, vi } from "vitest";

/** A worker whose recognize never settles, like tesseract.js's after terminate(). */
const terminated: string[] = [];
vi.mock("tesseract.js", () => ({
  OEM: { LSTM_ONLY: 1 },
  createWorker: vi.fn(async (langs: string) => ({
    recognize: () => new Promise(() => {}),
    terminate: async () => void terminated.push(langs),
  })),
}));
vi.mock("wasm-feature-detect", () => ({ simd: async () => false }));
vi.mock("../pdf-loader", () => ({ pdfAssetUrl: (p: string) => `/${p}` }));

import { recognizeCanvas, terminateOcrSlot } from "./ocr-engine";

describe("B9: stopping one OCR slot (16.0)", () => {
  it("rejects the page that slot was reading and leaves the other slot alone", async () => {
    const canvas = {} as HTMLCanvasElement;
    const hung = recognizeCanvas(canvas, (x, y) => [x, y], "eng", 0);
    const other = recognizeCanvas(canvas, (x, y) => [x, y], "eng", 1);
    let otherSettled = false;
    other.then(
      () => (otherSettled = true),
      () => (otherSettled = true),
    );
    await new Promise((r) => setTimeout(r, 0));
    await terminateOcrSlot(0);
    await expect(hung).rejects.toThrow("OCR worker stopped");
    await new Promise((r) => setTimeout(r, 0));
    expect(otherSettled).toBe(false);
    expect(terminated).toEqual(["eng"]);
  });
});
