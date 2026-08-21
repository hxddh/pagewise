// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageGeometry } from "../../lib/pdf";

const PAGE_W = 600;
const PAGE_H = 800;

/** Upright page: the viewport transform only flips y, as a real one does. */
const upright: PageGeometry = {
  viewportWidth: PAGE_W,
  viewportHeight: PAGE_H,
  toPdfPoint: (x, y) => [x, PAGE_H - y],
  toViewportPoint: (x, y) => [x, PAGE_H - y],
  view: [0, 0, PAGE_W, PAGE_H],
};

/** A mark across the top tenth of the page, as `clientRectToPageRect` stores it. */
const marks = [
  {
    id: "m1",
    page: 1,
    // Top-left origin: 40pt DOWN from the page's top edge.
    rects: [{ x: 60, y: 40, width: 120, height: 20 }],
    text: "the first line",
    stamp: "s",
  },
];

vi.mock("../../lib/pdf", () => ({ getPageGeometry: async () => upright }));
vi.mock("../../lib/mark-store", () => ({ marksOnPage: () => marks }));
vi.mock("../../i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));

const { MarkLayer } = await import("./MarkLayer");

afterEach(cleanup);

/**
 * Where a mark is drawn.
 *
 * The conversion itself is unit-tested in `search-highlight.test.ts`. This is
 * the WIRING, and the wiring is what was broken: `topLeftRectToBox` and
 * `pdfRectToBox` have the same signature and the same return type, so calling
 * the wrong one type-checks, passes every unit test, and mirrors every mark a
 * reader has ever made about the middle of the page.
 *
 * That is the shape of defect this project keeps finding — a feature wired end
 * to end, dead or wrong at one boundary, with correct passing tests on both
 * sides of it. A test of the pure function cannot see it. This can.
 */
describe("MarkLayer", () => {
  it("draws a mark where the reader put it, not mirrored", async () => {
    const { container } = render(
      <MarkLayer path="/doc.pdf" page={1} revision={0} selectedId={null} onSelect={() => {}} />,
    );

    await waitFor(() => expect(container.querySelector(".pdf-mark")).not.toBeNull());
    const box = container.querySelector(".pdf-mark") as HTMLElement;

    // Compared as numbers: the percentages are computed, so an exact string
    // match trips over 2.4999999999999996 rather than over a moved mark.
    const pct = (v: string) => Number.parseFloat(v);

    // 40pt down an 800pt page is 5% down. Through the bottom-left conversion
    // this same mark was drawn at 92.5% — near the bottom of the page.
    expect(pct(box.style.top)).toBeCloseTo(5, 6);
    expect(pct(box.style.height)).toBeCloseTo(2.5, 6);
    expect(pct(box.style.left)).toBeCloseTo(10, 6);
    expect(pct(box.style.width)).toBeCloseTo(20, 6);
  });
});
