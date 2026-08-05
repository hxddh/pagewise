// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mark } from "../lib/mark-store";

const marks: Mark[] = [
  {
    id: "a",
    page: 3,
    rects: [{ x: 0, y: 0, width: 10, height: 10 }],
    text: "the passage worth asking about",
    note: "",
    createdAt: 1,
    stamp: "s",
  },
  {
    id: "b",
    page: 12,
    rects: [{ x: 0, y: 0, width: 10, height: 10 }],
    text: "",
    note: "the figure",
    kind: "region",
    createdAt: 2,
    stamp: "s",
  },
];

vi.mock("../lib/mark-store", () => ({ getMarks: () => marks }));
vi.mock("../i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

const { MarkSidebar } = await import("./MarkSidebar");

function renderSidebar(onAsk?: (mark: Mark) => void) {
  return render(
    <MarkSidebar
      path="/doc.pdf"
      revision={1}
      currentPage={1}
      selectedId={null}
      stale={false}
      tabs={null}
      onClose={() => {}}
      onSelect={() => {}}
      onAsk={onAsk}
    />,
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(cleanup);

describe("MarkSidebar", () => {
  it("offers to ask about each mark", () => {
    const onAsk = vi.fn();
    const { container } = renderSidebar(onAsk);

    const asks = container.querySelectorAll(".mark-ask-btn");
    expect(asks).toHaveLength(2);

    fireEvent.click(asks[0]!);
    expect(onAsk).toHaveBeenCalledWith(marks[0]);
  });

  it("does not offer it when there is nowhere to ask", () => {
    const { container } = renderSidebar(undefined);
    expect(container.querySelectorAll(".mark-ask-btn")).toHaveLength(0);
  });

  it("keeps jumping to the mark as a separate action from asking", () => {
    const onAsk = vi.fn();
    const { container } = renderSidebar(onAsk);

    // The row is a jump target and an ask button, not one control doing both —
    // and not a button inside a button, which is not valid markup.
    const row = container.querySelector(".mark-row")!;
    expect(row.querySelectorAll("button")).toHaveLength(2);
    expect(row.querySelector("button button")).toBeNull();
  });
});
