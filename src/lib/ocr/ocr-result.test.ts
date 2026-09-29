import { describe, expect, it } from "vitest";
import { flatPixelToPdf, ocrPageFrom, type OcrWordIn } from "./ocr-result";
import { locateQuote } from "../quote-locate";

const word = (text: string, x0: number, y0: number, x1: number, y1: number, confidence = 90): OcrWordIn => ({
  text,
  confidence,
  bbox: { x0, y0, x1, y1 },
});

// A Letter page rendered at 200 dpi: scale 200/72, 792pt high.
const SCALE = 200 / 72;
const toPdf = flatPixelToPdf(SCALE, 792);

describe("ocrPageFrom", () => {
  it("emits one run per word in PDF points, bottom-left origin", () => {
    const page = ocrPageFrom(
      { blocks: [{ paragraphs: [{ lines: [{ words: [word("Revenue", 200, 278, 400, 311)] }] }] }] },
      toPdf,
    );
    expect(page.items).toHaveLength(1);
    const r = page.items[0]!.rect;
    expect(r.x).toBeCloseTo(72, 0);
    // Top of the word at 278px from the top is 792 - 100 = 692pt from the bottom.
    expect(r.y + r.height).toBeCloseTo(692, 0);
    expect(r.width).toBeCloseTo(72, 0);
  });

  it("joins lines into a paragraph, rejoining a hyphenated word", () => {
    const page = ocrPageFrom(
      {
        blocks: [
          {
            paragraphs: [
              { lines: [{ words: [word("it", 0, 0, 10, 10), word("became", 12, 0, 40, 10), word("dan-", 42, 0, 60, 10)] }, { words: [word("gerous", 0, 20, 30, 30), word("today.", 32, 20, 60, 30)] }] },
              { lines: [{ words: [word("Next", 0, 50, 20, 60)] }] },
            ],
          },
        ],
      },
      toPdf,
    );
    expect(page.text).toBe("it became dangerous today.\n\nNext");
  });

  it("sets CJK without spaces, as it was printed", () => {
    const page = ocrPageFrom(
      { blocks: [{ paragraphs: [{ lines: [{ words: ["甲", "方", "有", "权", "PW-1"].map((c, i) => word(c, i * 20, 0, i * 20 + 18, 20)) }] }] }] },
      toPdf,
    );
    expect(page.text).toBe("甲方有权 PW-1");
  });

  it("drops words recognised with too little confidence to mean anything", () => {
    const page = ocrPageFrom(
      { blocks: [{ paragraphs: [{ lines: [{ words: [word("real", 0, 0, 30, 10, 95), word("~,", 40, 0, 45, 10, 12)] }] }] }] },
      toPdf,
    );
    expect(page.items.map((i) => i.text)).toEqual(["real"]);
    expect(page.confidence).toBe(95);
  });

  it("yields runs a citation can be located among", () => {
    const words = "The filter admits a newcomer only if it is popular".split(" ");
    let x = 100;
    const page = ocrPageFrom(
      { blocks: [{ paragraphs: [{ lines: [{ words: words.map((w) => { const b = word(w, x, 300, x + w.length * 14, 330); x += w.length * 14 + 12; return b; }) }] }] }] },
      toPdf,
    );
    expect(locateQuote(page.items, "admits a newcomer only if it is popular").status).toBe("located");
    expect(locateQuote(page.items, "admits a newcomer if only it is popular").status).toBe("absent");
  });

  it("is empty, not broken, on a blank page", () => {
    expect(ocrPageFrom({ blocks: null }, toPdf)).toEqual({ items: [], text: "", confidence: 0 });
  });
});
