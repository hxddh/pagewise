// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  progress: null as { page: number; total: number } | null,
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
    h.progress = { page: 3, total: 12 };
    render(<ReadingLine path="/doc.pdf" />);
    expect(screen.getByText("preview.readingPageOf")).toBeTruthy();
    expect(screen.getByText("common.cancel")).toBeTruthy();
  });

  it("appears and disappears with the queue", () => {
    const { container } = render(<ReadingLine path="/doc.pdf" />);
    act(() => {
      h.progress = { page: 1, total: 4 };
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
    h.progress = { page: 2, total: 6 };
    render(<ReadingLine path="/doc.pdf" />);
    fireEvent.click(screen.getByText("common.cancel"));
    expect(h.cancelled).toEqual(["/doc.pdf"]);
  });
});
