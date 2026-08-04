import { describe, expect, it } from "vitest";
import { figuresOnPage, pagesWithFigures } from "./read-figure";
import type { DocFigure } from "./types";

function figure(page: number, width: number, height: number, x = 0): DocFigure {
  return { page, rect: { x, y: 0, width, height } };
}

describe("figuresOnPage", () => {
  it("keeps only figures on the requested page", () => {
    const figures = [figure(1, 200, 150), figure(2, 200, 150)];
    expect(figuresOnPage(figures, 1)).toHaveLength(1);
    expect(figuresOnPage(figures, 1)[0]!.page).toBe(1);
  });

  it("orders by area, so index 1 is the figure a reader would mean", () => {
    const small = figure(1, 60, 60, 0);
    const large = figure(1, 300, 200, 100);
    expect(figuresOnPage([small, large], 1)[0]).toBe(large);
  });

  it("drops decoration that would cost a billed call and describe nothing", () => {
    // Rules, bullets and logos are embedded images too.
    const rule = figure(1, 400, 2);
    const bullet = figure(1, 8, 8);
    const real = figure(1, 300, 200);
    expect(figuresOnPage([rule, bullet, real], 1)).toEqual([real]);
  });

  it("treats a document with no figures as empty rather than throwing", () => {
    expect(figuresOnPage(undefined, 1)).toEqual([]);
    expect(figuresOnPage([], 1)).toEqual([]);
  });
});

describe("pagesWithFigures", () => {
  it("lists each page once, in order", () => {
    const figures = [figure(3, 200, 150), figure(1, 300, 200), figure(3, 100, 100)];
    expect(pagesWithFigures(figures)).toEqual([1, 3]);
  });

  it("applies the same size filter as the reader", () => {
    // Advertising a page whose only image the reader would skip sends the
    // model to a tool that reports nothing.
    expect(pagesWithFigures([figure(1, 400, 2), figure(2, 8, 8)])).toEqual([]);
  });

  it("treats a document with no figures as empty", () => {
    expect(pagesWithFigures(undefined)).toEqual([]);
  });
});
