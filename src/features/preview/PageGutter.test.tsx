// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mark } from "../../lib/mark-store";
import type { Finding } from "../../lib/finding-store";
import type { AnswerNote, PageCitation } from "../../lib/page-citations";

const marks: Mark[] = [
  // Rectangles the page's own text has: the marks' anchors, for the column.
  { id: "m1", page: 2, rects: [{ x: 100, y: 100, width: 50, height: 10 }], text: "the passage", note: "", createdAt: 1, stamp: "s" },
  { id: "m2", page: 2, rects: [{ x: 100, y: 100, width: 50, height: 10 }], text: "", note: "the figure", createdAt: 2, stamp: "s", kind: "region" },
];

const findings: Finding[] = [
  {
    id: "f1",
    pages: [2],
    claim: "Page 2 is filler.",
    evidence: "",
    createdAt: 1,
    stamp: "s",
    author: undefined,
  },
];

const citations = new Map<number, PageCitation[]>([
  [2, [{ messageId: "a1", page: 2, quote: "quoted words" }]],
]);

vi.mock("../../lib/mark-store", () => ({ getMarks: () => marks }));
vi.mock("../../lib/finding-store", () => ({
  getFindings: () => findings,
  findingsOnPage: () => findings,
  isSuperseded: () => false,
}));
vi.mock("../../i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));
// The finding's words are on the page: `placeFinding` locates them, and the
// anchor is the run they were found in.
vi.mock("../../lib/finding-anchors", () => ({
  placeFinding: async () => ({
    status: "located",
    anchor: { page: 2, bounds: { x: 200, y: 682, width: 50, height: 10 } },
  }),
}));
// A Letter page at scale 1: enough for the real `topLeftRectToBox` /
// `pdfRectToBox` to place a mark's own rectangle.
vi.mock("../../lib/pdf", () => ({
  getPageGeometry: async () => ({
    viewportWidth: 612,
    viewportHeight: 792,
    view: [0, 0, 612, 792],
    toPdfPoint: (x: number, y: number) => [x, 792 - y],
    toViewportPoint: (x: number, y: number) => [x, 792 - y],
  }),
}));

const { PageGutter } = await import("./PageGutter");

const box = { top: 24, left: "calc(50% + 306px)", height: 792, width: 24 };

function renderGutter(handlers: Partial<Parameters<typeof PageGutter>[0]> = {}) {
  return render(
    <PageGutter
      path="/doc.pdf"
      page={2}
      box={box}
      revision={1}
      column={false}
      citations={citations}
      totalPages={3}
      onSelectMark={() => {}}
      onSelectFinding={() => {}}
      onRevealMessage={() => {}}
      {...handlers}
    />,
  );
}

afterEach(cleanup);

describe("PageGutter", () => {
  it("draws one dot per mark, finding and citing answer, in that order", () => {
    const { container } = renderGutter();
    const dots = [...container.querySelectorAll<HTMLElement>(".gutter-dot")];
    expect(dots.map((d) => d.dataset.gutterKind)).toEqual([
      "mark",
      "mark",
      "finding",
      "answer",
    ]);
  });

  it("puts the strip in the page's margin without touching the page's box", () => {
    // Zero layout shift: the strip is absolutely positioned, and it is given
    // the layout's own numbers rather than a second opinion about where the
    // page is.
    const { container } = renderGutter();
    const gutter = container.querySelector<HTMLElement>(".page-gutter")!;
    // The position itself is the stylesheet's (`position: absolute`); what the
    // layout hands over is where — the page's own top, outer edge and height.
    expect(gutter.style.top).toBe("24px");
    expect(gutter.style.left).toBe("calc(50% + 306px)");
    expect(gutter.style.maxHeight).toBe("792px");
  });

  it("shows a short note on the dot", () => {
    const { container } = renderGutter();
    const [m1, m2, f1, a1] = [...container.querySelectorAll<HTMLElement>(".gutter-dot")];
    expect(m1!.title).toBe("the passage");
    expect(m2!.title).toBe("the figure");
    expect(f1!.title).toBe("Page 2 is filler.");
    expect(a1!.title).toBe("quoted words");
  });

  it("is keyboard reachable, and Enter activates it", () => {
    // The dots are real buttons, so Enter and Space are the platform's own
    // activation — nothing here re-implements a keyboard.
    const onSelectMark = vi.fn();
    const { container } = renderGutter({ onSelectMark });
    const dot = container.querySelector<HTMLButtonElement>(".gutter-dot-mark")!;
    expect(dot.tagName).toBe("BUTTON");
    expect(dot.getAttribute("type")).toBe("button");
    dot.focus();
    expect(document.activeElement).toBe(dot);
    fireEvent.click(dot);
    expect(onSelectMark).toHaveBeenCalledWith(2, "m1");
  });

  it("sends each kind of dot to its own place", () => {
    const onSelectMark = vi.fn();
    const onSelectFinding = vi.fn();
    const onRevealMessage = vi.fn();
    const { container } = renderGutter({ onSelectMark, onSelectFinding, onRevealMessage });

    fireEvent.click(container.querySelector<HTMLElement>(".gutter-dot-finding")!);
    expect(onSelectFinding).toHaveBeenCalledWith("f1", 2);

    fireEvent.click(container.querySelector<HTMLElement>(".gutter-dot-answer")!);
    expect(onRevealMessage).toHaveBeenCalledWith("a1");
  });

  it("draws nothing when the page has nothing in the margin", () => {
    const { container } = renderGutter({ citations: new Map() });
    // The marks and findings are still there; the empty case is a page with
    // neither, which the store mocks cannot express — so this asserts the
    // strip is driven by the entries, not by the props alone.
    expect(container.querySelectorAll(".gutter-dot")).toHaveLength(3);
    expect(container.querySelector(".gutter-dot-answer")).toBeNull();
  });

  it("ties a card the collision rule pushed to the passage it is about", async () => {
    // The two marks and the finding are all anchored at the same run, so the
    // column's no-overlap rule pushes the second and third cards down. The
    // first card sits at its passage and needs no tie; the pushed ones draw a
    // line from the passage's own place on the page to the card's top.
    const { container } = renderGutter({ column: true });
    await waitFor(() => expect(container.querySelectorAll(".gutter-note-leader")).toHaveLength(2));
    const cards = [...container.querySelectorAll<HTMLElement>(".gutter-note")];
    const tops = cards.map((c) => parseFloat(c.style.top));
    const leaders = [...container.querySelectorAll<HTMLElement>(".gutter-note-leader")];
    const ties = leaders.map((l) => ({
      from: parseFloat(l.style.top),
      to: parseFloat(l.style.top) + parseFloat(l.style.height),
      lane: l.dataset.tieLane,
    }));
    expect(cards).toHaveLength(3);
    // The tie starts where the card's passage is — the first card's own top,
    // since it sits at its passage — and ends at the pushed card's top.
    expect(ties[0]!.from).toBeCloseTo(tops[0]!, 1);
    expect(ties[0]!.to).toBeCloseTo(tops[1]!, 1);
    expect(ties[1]!.to).toBeCloseTo(tops[2]!, 1);
    // Each tie takes its own lane — ranked by the passage it comes from, the
    // topmost first (20.0) — so a second tie can never run along the first or
    // hide under a card's edge. The lanes' geometry is `preview.css`'s; this
    // pins that the two ties are told apart.
    expect(ties.map((t) => t.lane)).toEqual(["0", "1"]);
    // And each tie wears the ink of the card it belongs to: the classes that
    // carry `--note-ink` are the card's own, and `preview.css` draws the tie
    // with them — so a tie says which card it came from, and two ties are told
    // apart by hue as well as by lane.
    const ink = (el: HTMLElement, base: string) =>
      [...el.classList].filter((c) => c !== base).sort();
    expect(leaders.map((l) => ink(l, "gutter-note-leader"))).toEqual([
      ink(cards[1]!, "gutter-note"),
      ink(cards[2]!, "gutter-note"),
    ]);
  });

  it("says a sentence's state in the reader's words, not the check's own status", () => {
    // The answer card's word is the one the chip's headline and the footer's
    // tally use for `verified` (`level.verified`). The citation check's own
    // label (`trust.located.short`, "found") names the check, not the
    // sentence, and belongs to the CSV — it must not reach the column.
    const notes = new Map<number, AnswerNote[]>([
      [
        2,
        [
          {
            messageId: "a1",
            page: 2,
            text: "The first line names the specimen.",
            state: "verified",
            reason: "located",
            citations: [],
          },
        ],
      ],
    ]);
    const { container } = renderGutter({ column: true, notes });
    const state = container.querySelector<HTMLElement>(".gutter-note-answer .gutter-note-state");
    expect(state?.textContent).toBe("level.verified");
    expect(state?.textContent).not.toBe("trust.located.short");
  });
});
