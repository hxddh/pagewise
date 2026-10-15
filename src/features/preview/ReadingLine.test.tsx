// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  progress: null as
    | { state: "reading"; page: number; total: number }
    | { state: "stopped"; read: number; total: number; left: number }
    | null,
  listeners: new Set<() => void>(),
  cancelled: [] as string[],
}));

vi.mock("../../i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));
vi.mock("../../document/index-queue", () => ({
  readingProgress: () => h.progress,
  subscribeReadingProgress: (listener: () => void) => {
    h.listeners.add(listener);
    return () => h.listeners.delete(listener);
  },
  cancelReading: (path: string) => {
    h.cancelled.push(path);
    h.progress = null;
  },
}));

const { ReadingLine } = await import("./ReadingLine");

afterEach(() => {
  cleanup();
  h.progress = null;
  h.listeners.clear();
  h.cancelled.length = 0;
});

describe("the reading line", () => {
  it("draws nothing when nothing is being read", () => {
    const { container } = render(<ReadingLine path="/doc.pdf" />);
    expect(container.querySelector(".preview-reading-line")).toBeNull();
  });

  it("says which page is being read, of how many", () => {
    h.progress = { state: "reading", page: 3, total: 12 };
    render(<ReadingLine path="/doc.pdf" />);
    expect(screen.getByText("preview.readingPageOf")).toBeTruthy();
    expect(screen.getByText("common.cancel")).toBeTruthy();
  });

  it("appears and disappears with the queue", () => {
    const { container } = render(<ReadingLine path="/doc.pdf" />);
    act(() => {
      h.progress = { state: "reading", page: 1, total: 4 };
      h.listeners.forEach((l) => l());
    });
    expect(container.querySelector(".preview-reading-line")).not.toBeNull();

    act(() => {
      h.progress = null;
      h.listeners.forEach((l) => l());
    });
    expect(container.querySelector(".preview-reading-line")).toBeNull();
  });

  it("cancels this document's reading", () => {
    h.progress = { state: "reading", page: 2, total: 6 };
    render(<ReadingLine path="/doc.pdf" />);
    fireEvent.click(screen.getByText("common.cancel"));
    expect(h.cancelled).toEqual(["/doc.pdf"]);
  });

  it("says how a pass that stopped with pages unread ended, and offers nothing to cancel", () => {
    // The terminal state (20.0): a sweep the reader cancelled, or one that ran
    // into its page cap, keeps the line and names what is left. The button is
    // gone — there is no pass left to stop.
    const { container } = render(<ReadingLine path="/doc.pdf" />);
    act(() => {
      h.progress = { state: "stopped", read: 5, total: 12, left: 7 };
      h.listeners.forEach((l) => l());
    });
    expect(container.querySelector(".preview-reading-line")).not.toBeNull();
    expect(screen.getByText("preview.readingStopped")).toBeTruthy();
    expect(screen.queryByText("common.cancel")).toBeNull();
    expect(screen.queryByText("preview.readingPageOf")).toBeNull();
  });
});

describe("a stopped pass offers the way on (22.0)", () => {
  it("reads the rest through the scan-all flow", () => {
    h.progress = { state: "stopped", read: 50, total: 300, left: 250 };
    const onReadRest = vi.fn();
    render(<ReadingLine path="/doc.pdf" onReadRest={onReadRest} />);
    fireEvent.click(screen.getByText("preview.scanAllAction"));
    expect(onReadRest).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("common.cancel")).toBeNull();
  });
});
