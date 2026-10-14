// @vitest-environment jsdom
/**
 * What the keyboard reaches, in the order it reaches it (19.0, package 4).
 *
 * The two surfaces this file walks are the ones 19.0 changed: the record panel,
 * which gained the reader's marks beside the assistant's findings, and the page
 * margin, which is new. "Focusable" is not the property worth asserting — every
 * button is focusable — so each test reads the order off the DOM and compares
 * it to the order a reader would expect: the list's own controls, then each
 * entry's controls in the order they appear, and the marks after the findings
 * they belong beside.
 *
 * jsdom has no keyboard and no sequential focus navigation, so the walk is the
 * rule the browser applies, written out: focusable elements without a
 * `tabindex="-1"`, in document order (no element here sets a positive
 * tabindex, which is the one thing that would reorder it).
 */
import { cleanup, render } from "@testing-library/react";
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
vi.mock("../../i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));

import { RecordPanel } from "../../components/RecordPanel";
import { PageGutter } from "./PageGutter";
import { __resetFindingStoreForTests, addFinding } from "../../lib/finding-store";
import { __resetMarkStoreForTests, addMark } from "../../lib/mark-store";
import type { PageCitation } from "../../lib/page-citations";

const PATH = "/docs/paper.pdf";

/**
 * Every element the keyboard stops on, in the order it would, by its name.
 *
 * The name is what a reader would hear: the `aria-label` when there is one (a
 * dot in the margin has no text), otherwise the element's own text with its
 * children's text kept apart, so a row that shows a passage and a page number
 * reads as two things rather than one run-on.
 */
function focusOrder(root: HTMLElement): string[] {
  const focusable = root.querySelectorAll<HTMLElement>(
    "button, [href], input, select, textarea, [tabindex]",
  );
  return [...focusable]
    .filter(
      (el) =>
        !el.hasAttribute("disabled") &&
        el.getAttribute("tabindex") !== "-1" &&
        !el.closest('[aria-hidden="true"]') &&
        !el.closest("[hidden]"),
    )
    .map((el) => {
      const label = el.getAttribute("aria-label");
      if (label) return label.trim().slice(0, 32);
      const text = [...el.childNodes]
        .map((node) => node.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return (text || el.getAttribute("title") || "").slice(0, 32);
    });
}

beforeEach(() => {
  __resetFindingStoreForTests();
  __resetMarkStoreForTests();
});
afterEach(cleanup);

describe("the keyboard's walk through the record panel", () => {
  it("reaches the findings first, then their controls, then the marks", () => {
    addFinding(PATH, {
      pages: [4, 2],
      claim: "The trial ran eight weeks.",
      stamp: "s",
      body: "Eight weeks, unless the site closed.",
      source: { messageId: "m7" },
    });
    addMark(PATH, {
      page: 3,
      rects: [{ x: 0, y: 0, width: 10, height: 10 }],
      text: "the passage",
      stamp: "s",
    });

    const { container } = render(
      <RecordPanel
        path={PATH}
        revision={1}
        currentPage={1}
        stale={false}
        stamp="s"
        totalPages={9}
        onJumpToPage={() => {}}
        onRevealMessage={() => {}}
      />,
    );

    expect(focusOrder(container)).toEqual([
      // The list's own controls, in the order they are drawn.
      "record.filterPlaceholder",
      "record.thisPage",
      // The entry: what it is, then how to change it.
      "record.editClaim",
      "marks.strike",
      "record.showBody",
      "record.confirm",
      // The pages the claim cites, as their printed numbers.
      "2",
      "4",
      "record.backToAnswer",
      // The reader's own ink, after the assistant's conclusions.
      "the passage 3",
      "marks.delete",
    ]);
  });

  it("reaches the marks even when nothing has been established", () => {
    addMark(PATH, {
      page: 3,
      rects: [{ x: 0, y: 0, width: 10, height: 10 }],
      text: "the only thing here",
      stamp: "s",
    });
    const { container } = render(
      <RecordPanel
        path={PATH}
        revision={1}
        currentPage={1}
        stale={false}
        stamp="s"
        onJumpToPage={() => {}}
      />,
    );
    expect(focusOrder(container)).toEqual(["the only thing here 3", "marks.delete"]);
  });
});

describe("the keyboard's walk through the page margin", () => {
  it("reaches the dots in the order the margin lists them", () => {
    addMark(PATH, {
      page: 2,
      rects: [{ x: 0, y: 0, width: 10, height: 10 }],
      text: "the passage",
      stamp: "s",
    });
    addFinding(PATH, { pages: [2], claim: "Page 2 is filler.", stamp: "s" });
    const citations = new Map<number, PageCitation[]>([
      [2, [{ messageId: "a1", page: 2, quote: "quoted words" }]],
    ]);

    const { container } = render(
      <PageGutter
        path={PATH}
        page={2}
        box={{ top: 0, left: "calc(50% + 300px)", height: 792 }}
        revision={1}
        citations={citations}
        onSelectMark={() => {}}
        onSelectFinding={() => {}}
        onRevealMessage={() => {}}
      />,
    );

    // The reader's ink, the assistant's conclusion, then the answer that
    // talked about the page — the same order the dots are drawn in.
    expect(focusOrder(container)).toEqual([
      "marks.markPlain",
      "record.onPage",
      "gutter.answerCites",
    ]);
  });
});
