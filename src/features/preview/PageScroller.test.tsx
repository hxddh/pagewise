// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedDocument } from "../../lib/types";

const measured: number[][] = [];
/** Per-page heights the fake measurer reports. Default: every page is Letter. */
let heightFor: (page: number) => number = () => 792;
/**
 * Answers held back until the test releases them.
 *
 * Real measurements arrive after the reader has already been looking at the
 * approximate layout for a moment — which is the whole reason the column can
 * reflow under them. A mock that answers inside the effect that asked can never
 * reproduce that.
 */
let deferred: Array<() => void> | null = null;
const flushMeasurements = () => {
  const pending = deferred ?? [];
  deferred = [];
  for (const answer of pending) answer();
};

vi.mock("../../lib/pdf", () => ({
  measurePages: (
    _path: string,
    pages: number[],
    onMeasured: (m: Array<{ page: number; size: { width: number; height: number } }>) => void,
  ) => {
    measured.push([...pages]);
    const answer = () =>
      onMeasured(pages.map((page) => ({ page, size: { width: 612, height: heightFor(page) } })));
    if (deferred) deferred.push(answer);
    else answer();
    return Promise.resolve();
  },
  renderPageToCanvas: () => Promise.resolve({ cancelled: false }),
  renderTextLayer: () => Promise.resolve(() => {}),
  tryApplyCachedPage: () => true,
  buildScaleKey: () => "k",
  effectiveRenderQuality: () => "high",
  isRasterHeavyPage: () => false,
}));

vi.mock("../../lib/doc-text", () => ({ getPageTextLen: () => 0 }));
vi.mock("../../i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));

const { PageScroller } = await import("./PageScroller");

const VIEWPORT_W = 800;
const VIEWPORT_H = 600;

function doc(totalPages: number): LoadedDocument {
  return {
    kind: "pdf",
    path: "/doc.pdf",
    name: "doc.pdf",
    totalPages,
    pages: [],
  } as unknown as LoadedDocument;
}

beforeEach(() => {
  measured.length = 0;
  heightFor = () => 792;
  deferred = null;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // jsdom has no layout, so the container has no size of its own.
  Object.defineProperty(HTMLDivElement.prototype, "clientWidth", {
    configurable: true,
    get: () => VIEWPORT_W,
  });
  Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
    configurable: true,
    get: () => VIEWPORT_H,
  });
});

afterEach(cleanup);

function scrollTo(node: Element, top: number) {
  Object.defineProperty(node, "scrollTop", { configurable: true, writable: true, value: top });
  fireEvent.scroll(node);
}

/** Let the scroll position land: it is committed once per frame, by design. */
async function frame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

/** The scroller as the app wires it: it reports the page, and is told it back. */
function Controlled({ totalPages }: { totalPages: number }) {
  const [page, setPage] = useState(1);
  return (
    <PageScroller
      doc={doc(totalPages)}
      page={page}
      onPageChange={setPage}
      zoom="fit-width"
      quality="crisp"
    />
  );
}

function mountedPages(container: HTMLElement): number[] {
  return [...container.querySelectorAll(".pdf-page-slot")].map((el) =>
    Number(el.getAttribute("data-page")),
  );
}

/**
 * These are the first tests in this project that render a component.
 *
 * 6.0.0 shipped a scroller that could not scroll: the whole gesture the product
 * is built on, changed without ever being run. Every one of its defects was
 * found by reading, twice too late. What follows pins the behaviour that
 * reading missed.
 */
describe("PageScroller", () => {
  it("mounts only the pages near the viewport", async () => {
    const { container } = render(
      <PageScroller
        doc={doc(500)}
        page={1}
        onPageChange={() => {}}
        zoom="fit-width"
        quality="crisp"
      />,
    );

    await waitFor(() => expect(mountedPages(container).length).toBeGreaterThan(0));
    // A 500-page document holds a handful of canvases, not 500.
    expect(mountedPages(container).length).toBeLessThan(6);
    expect(mountedPages(container)[0]).toBe(1);
  });

  it("measures a bounded window rather than every page", async () => {
    render(
      <PageScroller
        doc={doc(500)}
        page={1}
        onPageChange={() => {}}
        zoom="fit-width"
        quality="crisp"
      />,
    );

    await waitFor(() => expect(measured.length).toBeGreaterThan(0));
    const asked = new Set(measured.flat());
    expect(asked.has(1)).toBe(true);
    // Opening a document used to load all 500. The window plus its margin is
    // tens of pages, never hundreds.
    expect(asked.size).toBeLessThan(40);
  });

  it("reports the page the viewport is on when the reader scrolls", async () => {
    const onPageChange = vi.fn();
    const { container } = render(
      <PageScroller
        doc={doc(20)}
        page={1}
        onPageChange={onPageChange}
        zoom="fit-width"
        quality="crisp"
      />,
    );
    const scroller = container.querySelector(".pdf-scroller")!;
    await waitFor(() => expect(mountedPages(container).length).toBeGreaterThan(0));

    // Page height at fit-width: (800 - 48) / 612 * 792 ≈ 973, plus a 16px gap.
    const pageStride = Math.round((792 * (VIEWPORT_W - 48)) / 612) + 16;
    scrollTo(scroller, pageStride * 2 + 16);

    await waitFor(() => expect(onPageChange).toHaveBeenCalled());
    expect(onPageChange).toHaveBeenLastCalledWith(3);
  });

  it("mounts the pages it scrolled to, and drops the ones it left", async () => {
    // Controlled, as the app has it: the scroller reports the page and is told
    // it back. Pinning `page` while the reader scrolls elsewhere is not a state
    // the app can be in, and the scroller would rightly drag the view back to
    // the page it was still being told it was on.
    const { container } = render(<Controlled totalPages={50} />);
    const scroller = container.querySelector(".pdf-scroller")!;
    await waitFor(() => expect(mountedPages(container).length).toBeGreaterThan(0));

    const pageStride = Math.round((792 * (VIEWPORT_W - 48)) / 612) + 16;
    scrollTo(scroller, pageStride * 9 + 16);

    await waitFor(() => expect(mountedPages(container)).toContain(10));
    expect(mountedPages(container)).not.toContain(1);
  });

  it("releases the container reference when it unmounts", async () => {
    const seen: Array<HTMLDivElement | null> = [];
    const { unmount } = render(
      <PageScroller
        doc={doc(3)}
        page={1}
        onPageChange={() => {}}
        zoom="fit-width"
        quality="crisp"
        containerRef={(node) => seen.push(node)}
      />,
    );

    await waitFor(() => expect(seen.filter(Boolean).length).toBeGreaterThan(0));
    unmount();

    // React 19 calls a ref callback's cleanup instead of invoking it with null,
    // so the null has to come from the cleanup itself. Whoever holds this ref
    // otherwise keeps pointing at a node that has left the document.
    expect(seen[seen.length - 1]).toBeNull();
  });

  it("does not re-render mounted pages on every scroll event", async () => {
    const renderOverlays = vi.fn(() => null);
    const { container } = render(
      <PageScroller
        doc={doc(20)}
        page={1}
        onPageChange={() => {}}
        zoom="fit-width"
        quality="crisp"
        renderOverlays={renderOverlays}
      />,
    );
    const scroller = container.querySelector(".pdf-scroller")!;
    await waitFor(() => expect(mountedPages(container).length).toBeGreaterThan(0));

    const before = renderOverlays.mock.calls.length;
    // Ten scroll positions within the same page, each one committed on its own
    // frame: nothing about any mounted page has changed, so no mounted page
    // should render again. Before 6.1 each page was handed a fresh overlay
    // closure per render, so `memo` never matched and every mounted page —
    // with its highlight, mark, link and region layers — reconciled per frame.
    for (let i = 1; i <= 10; i++) {
      scrollTo(scroller, i * 4);
      await frame();
    }

    expect(renderOverlays.mock.calls.length).toBe(before);
  });

  it("keeps the reader's place when a page above them is measured", async () => {
    // Pages are measured as the reader reaches them, so a stretch that was
    // jumped over is still standing in at page 1's height. Measuring it moves
    // everything below — including the paragraph being read. Measured in a
    // browser before this was written down: on a sixty-page document, one
    // scroll up moved the text by nothing at all and a later one lost 488px of
    // it — most of a screen, mid-sentence.
    deferred = [];
    const { container } = render(<Controlled totalPages={40} />);
    const scroller = container.querySelector(".pdf-scroller")! as HTMLDivElement;
    await act(async () => flushMeasurements());
    await waitFor(() => expect(mountedPages(container).length).toBeGreaterThan(0));

    // Well past the measured window, so the pages between are still guesses.
    // Deliberately 300px INTO page 21 rather than at its top: at a page top the
    // effect that pulls the view back to the current page happens to land in
    // the right place on its own, and a test written there passes whether this
    // works or not. Mid-page is where a reader actually is.
    const pageStride = Math.round((792 * (VIEWPORT_W - 48)) / 612) + 16;
    scrollTo(scroller, pageStride * 20 + 300);
    await frame();
    await waitFor(() => expect(mountedPages(container)).toContain(21));

    const slotTop = () =>
      Number(
        (container.querySelector('.pdf-page-slot[data-page="21"]') as HTMLElement).style.top.replace(
          "px",
          "",
        ),
      );
    const before = { top: slotTop(), scroll: scroller.scrollTop };

    // Page 12 turns out to be twice the height everything was guessed at.
    heightFor = (page) => (page === 12 ? 1584 : 792);
    await act(async () => flushMeasurements());
    await waitFor(() => expect(slotTop()).not.toBe(before.top));

    // Whatever the column did to the page the reader is on, the scroll did the
    // same — so on screen it did not move at all.
    expect(scroller.scrollTop - before.scroll).toBe(slotTop() - before.top);
  });

  it("scrolls to a page the rest of the app navigated to", async () => {
    const onPageChange = vi.fn();
    const { container, rerender } = render(
      <PageScroller
        doc={doc(20)}
        page={1}
        onPageChange={onPageChange}
        zoom="fit-width"
        quality="crisp"
      />,
    );
    const scroller = container.querySelector(".pdf-scroller")! as HTMLDivElement;
    await waitFor(() => expect(mountedPages(container).length).toBeGreaterThan(0));

    rerender(
      <PageScroller
        doc={doc(20)}
        page={7}
        onPageChange={onPageChange}
        zoom="fit-width"
        quality="crisp"
      />,
    );

    await waitFor(() => expect(mountedPages(container)).toContain(7));
    expect(scroller.scrollTop).toBeGreaterThan(0);
    // Scrolling itself to a page must not echo back as the reader navigating.
    expect(onPageChange).not.toHaveBeenCalled();
  });
});
