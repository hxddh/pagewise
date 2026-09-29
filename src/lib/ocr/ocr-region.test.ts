import { describe, expect, it } from "vitest";
import { wordsInRegion } from "./ocr-region";
import type { TextItemRect } from "../types";

const w = (text: string, x: number, y: number): TextItemRect => ({ text, rect: { x, y, width: 30, height: 10 } });

describe("wordsInRegion", () => {
  // A page whose visible box starts at (10, 20) and is 792pt tall above that.
  const view = [10, 20, 622, 812] as const;
  const words = [w("Second", 110, 680), w("First", 70, 700), w("line", 110, 700), w("outside", 400, 700), w("line.", 150, 680)];

  it("keeps the words inside the rectangle, line by line in reading order", () => {
    // Stored frame: x from the visible left, y down from the visible top.
    const region = { x: 50, y: 812 - 715, width: 150, height: 40 };
    expect(wordsInRegion(words, region, view)).toBe("First line\nSecond line.");
  });

  it("sets Chinese without spaces", () => {
    const zh = ["甲", "方", "有", "权"].map((c, i) => w(c, 70 + i * 12, 700));
    expect(wordsInRegion(zh, { x: 50, y: 97, width: 200, height: 30 }, view)).toBe("甲方有权");
  });

  it("is empty when nothing was recognised there", () => {
    expect(wordsInRegion(words, { x: 500, y: 10, width: 20, height: 20 }, view)).toBe("");
  });
});
