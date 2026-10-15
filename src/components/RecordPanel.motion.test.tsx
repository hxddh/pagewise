// @vitest-environment jsdom
/**
 * The list movement (19.0): a record entry arrives and leaves rather than the
 * list being rearranged in one frame. Asserted here because it is motion's, and
 * the reduced-motion half of it — the reader's preference being honoured — has
 * its own file, since motion caches that query once per module registry and
 * vitest isolates one file from the next.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));

import { RecordPanel } from "./RecordPanel";
import { __resetFindingStoreForTests, addFinding } from "../lib/finding-store";
import { __resetMarkStoreForTests } from "../lib/mark-store";

const PATH = "/docs/paper.pdf";

beforeEach(() => {
  __resetFindingStoreForTests();
  __resetMarkStoreForTests();
});
afterEach(cleanup);

const view = (revision = 1) =>
  render(
    <RecordPanel
      path={PATH}
      revision={revision}
      currentPage={1}
      stale={false}
      onJumpToPage={() => {}}
    />,
  );

describe("the record list's movement", () => {
  it("lets an arriving entry rise into place", () => {
    addFinding(PATH, { pages: [1], claim: "First.", stamp: "s" });
    const { rerender } = view();
    expect(screen.getByText("First.")).toBeTruthy();

    addFinding(PATH, { pages: [2], claim: "Second.", stamp: "s" });
    rerender(
      <RecordPanel
        path={PATH}
        revision={2}
        currentPage={1}
        stale={false}
        onJumpToPage={() => {}}
      />,
    );

    const entries = document.querySelectorAll<HTMLElement>(".record-entry");
    expect(entries).toHaveLength(2);
    // Motion starts the new row hidden and plays it in. `opacity: 0` here is
    // the arrival being in flight, not a missing entry.
    expect(entries[1]!.style.opacity).toBe("0");
    expect(entries[1]!.style.transform).toContain("translateY(4px)");
  });

  it("keeps a leaving entry mounted while it fades out", () => {
    addFinding(PATH, { pages: [1], claim: "Alpha.", stamp: "s" });
    addFinding(PATH, { pages: [2], claim: "Beta.", stamp: "s" });
    view();

    // The filter removes Beta from the list; the exit animation is what keeps
    // it on screen for the moment it takes to leave.
    fireEvent.change(screen.getByLabelText("record.filterPlaceholder"), {
      target: { value: "alpha" },
    });
    expect(screen.queryByText("Alpha.")).toBeTruthy();
    expect(
      document.querySelectorAll(".record-entry").length,
      "the leaving entry was unmounted in the same frame",
    ).toBe(2);
  });
});
