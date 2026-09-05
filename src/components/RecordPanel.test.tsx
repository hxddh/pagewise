// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  getFindings,
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

/**
 * 12.0: one trust line per entry, the whole answer under its claim, and the
 * way back to where it came from.
 */
describe("the record panel, 12.0", () => {
  const trusted = (currentPage = 1, extra: Partial<Parameters<typeof RecordPanel>[0]> = {}) =>
    render(
      <RecordPanel
        path={PATH}
        revision={1}
        currentPage={currentPage}
        stale={false}
        stamp="s"
        totalPages={9}
        onJumpToPage={() => {}}
        {...extra}
      />,
    );

  it("keeps the whole answer under its one-line claim, shown on request", () => {
    addFinding(PATH, {
      pages: [1],
      claim: "Eight weeks.…",
      stamp: "s",
      author: "reader",
      body: "| week | n |\n|---|---|\n| 8 | 40 |\n\nEight weeks, **unless** the site closed.",
      source: { messageId: "m7" },
    });
    const { container } = trusted();
    expect(container.querySelector(".record-body")).toBeNull();
    fireEvent.click(screen.getByText("record.showBody"));
    const body = container.querySelector(".record-body");
    expect(body, "the body renders as markdown, not as pipes").not.toBeNull();
    expect(body?.querySelector("table")).not.toBeNull();
    expect(body?.querySelector("strong")?.textContent).toBe("unless");
  });

  it("leads back to the answer an entry was kept from", () => {
    addFinding(PATH, {
      pages: [1],
      claim: "Kept.",
      stamp: "s",
      author: "reader",
      body: "Kept.",
      source: { messageId: "m7" },
    });
    const revealed: string[] = [];
    trusted(1, { onRevealMessage: (id) => revealed.push(id) });
    fireEvent.click(screen.getByText("record.backToAnswer"));
    expect(revealed).toEqual(["m7"]);
  });

  it("says an entry was written on an earlier version of the file, and lets the reader settle it", () => {
    addFinding(PATH, { pages: [1], claim: "Old.", stamp: "older-stamp" });
    const { container, rerender } = trusted();
    expect(container.querySelector(".record-entry")?.getAttribute("data-trust")).toBe("stale");
    expect(screen.getByText("record.trustStale")).toBeTruthy();

    fireEvent.click(screen.getByText("record.confirm"));
    // Checking it against the file that is open is what "re-check" asked for,
    // so the entry is carried forward to this version and vouched for.
    expect(getFindings(PATH)[0]?.confirmedAt).toBeTypeOf("number");
    expect(getFindings(PATH)[0]?.stamp).toBe("s");
    rerender(
      <RecordPanel
        path={PATH}
        revision={2}
        currentPage={1}
        stale={false}
        stamp="s"
        totalPages={9}
        onJumpToPage={() => {}}
      />,
    );
    expect(container.querySelector(".record-entry")?.getAttribute("data-trust")).toBe("confirmed");
    expect(screen.getByText("record.trustConfirmed")).toBeTruthy();
  });

  it("lets the reader rewrite a claim, and counts that as checking it", () => {
    addFinding(PATH, { pages: [1], claim: "Six weeks.", stamp: "s" });
    const { container } = trusted();
    expect(container.querySelector(".record-entry")?.getAttribute("data-trust")).toBe("unverified");
    fireEvent.click(screen.getByLabelText("record.editClaim"));
    const input = screen.getByLabelText("record.claimLabel") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Eight weeks." } });
    fireEvent.submit(input.closest("form")!);
    expect(getFindings(PATH)[0]?.claim).toBe("Eight weeks.");
    expect(getFindings(PATH)[0]?.confirmedAt).toBeTypeOf("number");
  });

  it("never shows a claim on a page past the end as standing", () => {
    addFinding(PATH, { pages: [999], claim: "Nowhere.", stamp: "s" });
    const { container } = trusted();
    expect(container.querySelector(".record-entry-inactive")).not.toBeNull();
    expect(screen.getByText("record.trustRetracted")).toBeTruthy();
  });
});
