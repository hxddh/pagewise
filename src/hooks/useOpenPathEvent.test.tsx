// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: { payload: unknown }) => void;
let handlers: Array<{ name: string; fn: Handler }> = [];
let released = 0;
/** Resolve `listen` on demand, so the unmount-before-subscribe race is testable. */
let deferred: Array<() => void> = [];
let defer = false;

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: Handler) =>
    new Promise<() => void>((resolve) => {
      const done = () => {
        handlers.push({ name, fn });
        resolve(() => {
          released += 1;
        });
      };
      if (defer) deferred.push(done);
      else done();
    }),
}));

const { useOpenPathEvent, OPEN_PATH_EVENT } = await import("./useOpenPathEvent");

function Harness({ onPath }: { onPath: (p: string) => void }) {
  useOpenPathEvent(onPath);
  return null;
}

const emit = (payload: unknown) =>
  act(() => {
    for (const h of handlers) h.fn({ payload });
  });

beforeEach(() => {
  handlers = [];
  released = 0;
  deferred = [];
  defer = false;
});
afterEach(cleanup);

/**
 * A document opened from outside the app.
 *
 * Double-clicking a PDF starts a second copy of the process; the
 * single-instance plugin turns it back and hands its command line to the window
 * already running. This is where that path lands. Without it a reader ends up
 * with two windows, two conversations and two ideas of which document is open.
 */
describe("useOpenPathEvent", () => {
  it("hands over the path a second launch carried", async () => {
    const onPath = vi.fn();
    render(<Harness onPath={onPath} />);
    await waitFor(() => expect(handlers).toHaveLength(1));
    expect(handlers[0]!.name).toBe(OPEN_PATH_EVENT);

    emit("/docs/paper.pdf");
    expect(onPath).toHaveBeenCalledWith("/docs/paper.pdf");
  });

  it("ignores a payload that is not a usable path", async () => {
    const onPath = vi.fn();
    render(<Harness onPath={onPath} />);
    await waitFor(() => expect(handlers).toHaveLength(1));

    emit("");
    emit("   ");
    emit(null);
    emit(42);
    expect(onPath).not.toHaveBeenCalled();
  });

  it("subscribes once, however often its owner re-renders", async () => {
    // A dependency on the callback's identity would tear the listener down and
    // build it again on every render — and a launch landing in the gap is a
    // document that silently fails to open.
    const { rerender } = render(<Harness onPath={() => {}} />);
    await waitFor(() => expect(handlers).toHaveLength(1));
    for (let i = 0; i < 5; i += 1) rerender(<Harness onPath={() => {}} />);
    expect(handlers).toHaveLength(1);
    expect(released).toBe(0);
  });

  it("calls the newest callback, not the one it subscribed with", async () => {
    // The consequence of subscribing once: without the ref, the handler would
    // keep calling a stale closure and open the document into an old session.
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Harness onPath={first} />);
    await waitFor(() => expect(handlers).toHaveLength(1));
    rerender(<Harness onPath={second} />);

    emit("/docs/paper.pdf");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("/docs/paper.pdf");
  });

  it("releases a subscription that resolved after its owner unmounted", async () => {
    // `listen` is async. Unmount before it resolves and the cleanup has already
    // run with nothing to release, so the subscription has to release itself or
    // it points at a dead callback for the life of the process.
    defer = true;
    const { unmount } = render(<Harness onPath={() => {}} />);
    unmount();
    await act(async () => {
      for (const d of deferred) d();
    });
    expect(released).toBe(1);
  });
});
