// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return null;
    }
    async set() {}
    async save() {}
  },
}));
vi.mock("../i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));

import { MarkSidebar } from "./MarkSidebar";
import { __resetFindingStoreForTests, addFinding, reviseFinding, setFindingStruck } from "../lib/finding-store";

const PATH = "/docs/paper.pdf";

beforeEach(() => __resetFindingStoreForTests());
afterEach(cleanup);

const view = () =>
  render(
    <MarkSidebar
      path={PATH}
      revision={1}
      currentPage={1}
      selectedId={null}
      stale={false}
      tabs={null}
      onSelect={() => {}}
    />,
  );

/**
 * The record, as the reader sees it.
 *
 * Two authors in one list. The requirements here are the ones from the 9.0
 * design that fail silently if they regress: a claim always shows the pages it
 * came from, and a struck or superseded claim stays visible rather than
 * vanishing. Both are what let a reader tell what the assistant worked out from
 * what the page actually said — and the assistant is told these again next
 * turn, so a record the reader cannot audit is worse than none.
 */
describe("the record sidebar", () => {
  it("shows a finding with the pages it came from", () => {
    addFinding(PATH, { pages: [4, 2], claim: "The trial ran eight weeks.", stamp: "s" });
    const { container } = view();

    expect(screen.getByText("The trial ran eight weeks.")).toBeTruthy();
    // Ascending and complete: the reader has to be able to get to the text.
    expect(container.querySelector(".finding-item .outline-page")?.textContent).toBe("2, 4");
  });

  it("says whose claim it is, in words and not only in colour", () => {
    // A record that blurs the reader's marks with the assistant's inferences is
    // worse than no record. Colour alone does not survive a colour-blind reader
    // or a screenshot.
    addFinding(PATH, { pages: [1], claim: "Something.", stamp: "s" });
    const { container } = view();
    expect(container.querySelector(".finding-byline")).not.toBeNull();
  });

  it("keeps a struck finding on screen, marked", () => {
    // Removing it would leave the reader no way to undo the strike.
    const f = addFinding(PATH, { pages: [1], claim: "Wrong thing.", stamp: "s" });
    setFindingStruck(PATH, f!.id, true);
    const { container } = view();

    expect(screen.getByText("Wrong thing.")).toBeTruthy();
    expect(container.querySelectorAll(".finding-row-inactive")).toHaveLength(1);
  });

  it("keeps the claim a revision overturned, beside the correction", () => {
    // A revision that hid what it replaced would leave no trace of the
    // assistant having been wrong, which is the whole reason revision exists
    // rather than overwriting in place.
    const first = addFinding(PATH, { pages: [2], claim: "Six weeks.", stamp: "s" });
    reviseFinding(PATH, first!.id, { pages: [5], claim: "Eight weeks.", stamp: "s" });
    const { container } = view();

    expect(screen.getByText("Six weeks.")).toBeTruthy();
    expect(screen.getByText("Eight weeks.")).toBeTruthy();
    expect(container.querySelectorAll(".finding-row-inactive")).toHaveLength(1);
  });
});
