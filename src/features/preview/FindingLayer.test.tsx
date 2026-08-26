// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextItemRect } from "../../lib/types";

/**
 * The assistant's conclusions, on the page.
 *
 * A unit test of `locateQuote` proves the words can be found; it cannot prove
 * this layer asks for the right page, converts through the right origin, or
 * draws anything at all. That gap is what 9.2.3 was — every mark mirrored, with
 * green unit tests on both sides, because `pdfRectToBox` and `topLeftRectToBox`
 * have the same signature and the same return type. So this asserts against
 * placed geometry, not against a call count.
 */

let runs: TextItemRect[] = [];
vi.mock("../../lib/pdf", () => ({
  pageTextItems: async () => runs,
  getPageGeometry: async () => ({
    // A Letter page, no rotation: viewport coordinates equal PDF points with
    // the y axis flipped, which `pdfRectToBox` does through this transform.
    viewportWidth: 612,
    viewportHeight: 792,
    view: [0, 0, 612, 792] as [number, number, number, number],
    toViewportPoint: (x: number, y: number) => [x, 792 - y] as [number, number],
  }),
}));

vi.mock("../../i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));

const { FindingLayer } = await import("./FindingLayer");
const { addFinding, __resetFindingStoreForTests } = await import("../../lib/finding-store");
const { clearFindingAnchors } = await import("../../lib/finding-anchors");

const PATH = "/docs/paper.pdf";

/** A run near the top of the page: y is measured UP from the bottom edge. */
const topRun = (text: string): TextItemRect => ({
  text,
  rect: { x: 61.2, y: 712.8, width: 306, height: 15.84 },
});

beforeEach(() => {
  __resetFindingStoreForTests();
  clearFindingAnchors();
  runs = [];
});
afterEach(cleanup);

const layer = (page = 1) =>
  render(
    <FindingLayer path={PATH} page={page} revision={1} selectedId={null} onSelect={() => {}} />,
  );

describe("FindingLayer", () => {
  it("draws a claim where its own wording is, not mirrored about the page", async () => {
    // The whole reason this layer can exist: the assistant gave words, and the
    // rectangle came from the page. A run 10% down the page must be drawn 10%
    // down — sending it through `topLeftRectToBox` instead would put it at 88%,
    // which type-checks and is what 9.2.3 shipped.
    runs = [topRun("Revenue fell by twelve percent in the second half.")];
    addFinding(PATH, {
      pages: [1],
      claim: "Revenue fell in H2.",
      evidence: "Revenue fell by twelve percent",
      stamp: "s",
    });

    layer();
    const box = await screen.findByRole("button");
    expect(parseFloat(box.style.top)).toBeCloseTo(8, 0);
    expect(parseFloat(box.style.left)).toBeCloseTo(10, 0);
  });

  it("draws nothing for a claim whose wording is not on the page", async () => {
    // The fabrication case. Silence here is correct — the record panel is where
    // the reader is told, because a warning painted over the page would be
    // pointing at nothing.
    runs = [topRun("Revenue fell by twelve percent in the second half.")];
    addFinding(PATH, {
      pages: [1],
      claim: "Revenue rose in H2.",
      evidence: "revenue rose by twelve percent",
      stamp: "s",
    });

    const { container } = layer();
    await waitFor(() => expect(container.querySelector(".pdf-finding-layer")).toBeNull());
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("draws nothing on a page the claim does not cite", async () => {
    // A finding citing pages 1 and 5 is placed on whichever carries the words.
    // Drawing it on both would put an anchor under text that does not say it.
    runs = [topRun("Revenue fell by twelve percent in the second half.")];
    addFinding(PATH, {
      pages: [1],
      claim: "Revenue fell in H2.",
      evidence: "Revenue fell by twelve percent",
      stamp: "s",
    });

    const { container } = layer(2);
    await waitFor(() => expect(container.querySelector(".pdf-finding-layer")).toBeNull());
  });

  it("does not draw a claim the reader struck", async () => {
    // Struck means the reader said it was wrong. It stays in the record, where
    // they can undo it, and stops being asserted over the document.
    runs = [topRun("Revenue fell by twelve percent in the second half.")];
    const { setFindingStruck } = await import("../../lib/finding-store");
    const finding = addFinding(PATH, {
      pages: [1],
      claim: "Revenue fell in H2.",
      evidence: "Revenue fell by twelve percent",
      stamp: "s",
    })!;
    setFindingStruck(PATH, finding.id, true);

    const { container } = layer();
    await waitFor(() => expect(container.querySelector(".pdf-finding-layer")).toBeNull());
  });

  it("does not draw a claim a later one replaced", async () => {
    runs = [topRun("Revenue fell by twelve percent in the second half.")];
    const first = addFinding(PATH, {
      pages: [1],
      claim: "Revenue fell in H2.",
      evidence: "Revenue fell by twelve percent",
      stamp: "s",
    })!;
    addFinding(PATH, {
      pages: [1],
      claim: "Revenue fell in H2, on a restated basis.",
      evidence: "Revenue fell by twelve percent",
      supersedes: first.id,
      stamp: "s",
    });

    layer();
    // One drawn, not two: the superseded claim is history, not a live anchor.
    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(1));
    expect(screen.getByRole("button").title).toContain("restated basis");
  });

  it("puts a margin tab beside the passage, at its own height", async () => {
    // The 9.0 promise `RecordPanel` recorded as impossible: findings drawn
    // beside the text they came from.
    runs = [topRun("Revenue fell by twelve percent in the second half.")];
    addFinding(PATH, {
      pages: [1],
      claim: "Revenue fell in H2.",
      evidence: "Revenue fell by twelve percent",
      stamp: "s",
    });

    const { container } = layer();
    await waitFor(() => expect(container.querySelector(".pdf-finding-tab")).not.toBeNull());
    const tab = container.querySelector(".pdf-finding-tab") as HTMLElement;
    expect(parseFloat(tab.style.top)).toBeCloseTo(8, 0);
  });
});
