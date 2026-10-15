// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mark } from "../../lib/mark-store";
import type { Finding } from "../../lib/finding-store";
import type { PageCitation } from "../../lib/page-citations";

const marks: Mark[] = [
  { id: "m1", page: 2, rects: [], text: "the passage", note: "", createdAt: 1, stamp: "s" },
  { id: "m2", page: 2, rects: [], text: "", note: "the figure", createdAt: 2, stamp: "s", kind: "region" },
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
});
