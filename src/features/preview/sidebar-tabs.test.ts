import { describe, expect, it } from "vitest";
import { sidebarTabState, type SidebarTab } from "./sidebar-tabs";

const TABS: SidebarTab[] = ["pages", "outline", "marks"];

describe("sidebarTabState", () => {
  it("shows exactly one panel, for every tab and either kind of document", () => {
    // The invariant the old code could not hold: Pages was selected on
    // `!showOutline`, which is also true with Marks open, so two tabs in one
    // tablist were `aria-selected` at once.
    for (const tab of TABS) {
      for (const hasOutline of [true, false]) {
        const state = sidebarTabState(tab, hasOutline);
        const shown = Object.values(state).filter(Boolean);
        expect(shown, `${tab} / outline:${hasOutline} showed ${shown.length} panels`).toHaveLength(
          1,
        );
      }
    }
  });

  it("shows the tab that was asked for", () => {
    expect(sidebarTabState("pages", true).showPages).toBe(true);
    expect(sidebarTabState("outline", true).showOutline).toBe(true);
    expect(sidebarTabState("marks", true).showMarks).toBe(true);
    expect(sidebarTabState("marks", false).showMarks).toBe(true);
  });

  it("falls back to pages when a document has no outline to show", () => {
    // Its tab is disabled in that case; this is what happens if it is reached
    // anyway — the same fallback the panel below the tabs already made.
    const state = sidebarTabState("outline", false);
    expect(state.showOutline).toBe(false);
    expect(state.showPages).toBe(true);
  });
});
