// @vitest-environment jsdom
/**
 * The list movement under `prefers-reduced-motion` (19.0): instant.
 *
 * A separate file from `RecordPanel.motion.test.tsx` on purpose. Motion reads
 * the media query into a module-level value the first time a component asks,
 * and vitest isolates a file's modules from every other file's — so the stub
 * below is installed before the first render in this file, and this file sees
 * "reduce" for all of its tests.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", (query: string) => ({
  matches: query.includes("prefers-reduced-motion"),
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
}));

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
import { __resetFindingStoreForTests, addFinding } from "../lib/finding-store";
import { __resetMarkStoreForTests } from "../lib/mark-store";

const PATH = "/docs/paper.pdf";

beforeEach(() => {
  __resetFindingStoreForTests();
  __resetMarkStoreForTests();
});
afterEach(cleanup);

const view = (revision: number) =>
  render(
    <RecordPanel
      path={PATH}
      revision={revision}
      currentPage={1}
      stale={false}
      onJumpToPage={() => {}}
    />,
  );

describe("the record list's movement, reduced", () => {
  it("shows an arriving entry at once, with no arrival to watch", () => {
    addFinding(PATH, { pages: [1], claim: "First.", stamp: "s" });
    const { rerender } = view(1);

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
    // No fade, no shift: the entry is simply there.
    expect(entries[1]!.style.opacity === "" || entries[1]!.style.opacity === "1").toBe(true);
    expect(entries[1]!.style.transform === "" || entries[1]!.style.transform === "none").toBe(true);
  });

  it("unmounts a leaving entry in the same frame", () => {
    addFinding(PATH, { pages: [1], claim: "Alpha.", stamp: "s" });
    addFinding(PATH, { pages: [2], claim: "Beta.", stamp: "s" });
    view(1);

    fireEvent.change(screen.getByLabelText("record.filterPlaceholder"), {
      target: { value: "alpha" },
    });
    expect(screen.queryByText("Beta.")).toBeNull();
    expect(document.querySelectorAll(".record-entry")).toHaveLength(1);
  });
});
