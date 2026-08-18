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

import { RecordPanel } from "./RecordPanel";
import {
  __resetFindingStoreForTests,
  addFinding,
  reviseFinding,
  setFindingStruck,
} from "../lib/finding-store";

const PATH = "/docs/paper.pdf";

beforeEach(() => __resetFindingStoreForTests());
afterEach(cleanup);

const view = (currentPage = 1) =>
  render(
    <RecordPanel
      path={PATH}
      revision={1}
      currentPage={currentPage}
      stale={false}
      onJumpToPage={() => {}}
    />,
  );

/**
 * The record, where the reader reads it.
 *
 * Moved here from the page sidebar in 9.2 — that column is 160px and sized for
 * a thumbnail, and a finding is prose. What these hold is what fails silently
 * if it regresses: a claim always shows the pages it came from, a struck or
 * superseded claim stays visible, and the two authors never blur together.
 * The assistant is told these entries again on the next question, so a record
 * the reader cannot audit is worse than none.
 */
describe("the record panel", () => {
  it("shows a claim with the pages it came from, as controls", () => {
    addFinding(PATH, { pages: [4, 2], claim: "The trial ran eight weeks.", stamp: "s" });
    const { container } = view();

    expect(screen.getByText("The trial ran eight weeks.")).toBeTruthy();
    const chips = [...container.querySelectorAll(".record-page-chip")].map((c) => c.textContent);
    expect(chips, "ascending, complete, and clickable").toEqual(["2", "4"]);
  });

  it("says whose claim it is, in words and not only in colour", () => {
    addFinding(PATH, { pages: [1], claim: "The assistant worked this out.", stamp: "s" });
    addFinding(PATH, { pages: [2], claim: "The reader kept this.", stamp: "s", author: "reader" });
    const { container } = view();

    const bylines = [...container.querySelectorAll(".record-byline")];
    expect(bylines).toHaveLength(2);
    // One of them is the reader's, and it is marked as such beyond its colour.
    expect(container.querySelectorAll(".record-byline-reader")).toHaveLength(1);
  });

  it("keeps a struck claim on screen, marked", () => {
    // Removing it would leave the reader no way to undo the strike.
    const f = addFinding(PATH, { pages: [1], claim: "Wrong thing.", stamp: "s" });
    setFindingStruck(PATH, f!.id, true);
    const { container } = view();

    expect(screen.getByText("Wrong thing.")).toBeTruthy();
    expect(container.querySelectorAll(".record-entry-inactive")).toHaveLength(1);
  });

  it("keeps the claim a revision overturned, beside the correction", () => {
    const first = addFinding(PATH, { pages: [2], claim: "Six weeks.", stamp: "s" });
    reviseFinding(PATH, first!.id, { pages: [5], claim: "Eight weeks.", stamp: "s" });
    const { container } = view();

    expect(screen.getByText("Six weeks.")).toBeTruthy();
    expect(screen.getByText("Eight weeks.")).toBeTruthy();
    expect(container.querySelectorAll(".record-entry-inactive")).toHaveLength(1);
  });

  it("says so when nothing has been established", () => {
    const { container } = view();
    expect(container.querySelector(".record-empty")).not.toBeNull();
  });
});
