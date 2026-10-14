// @vitest-environment jsdom
/**
 * The answer-insertion movement (19.0), on its own because it is the one
 * movement written in JavaScript: `useFlipRows` runs in a layout effect, where
 * the stylesheet's global reduced-motion block cannot reach it, so the reader's
 * preference is read and honoured here — and that is what this file asserts.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";

vi.mock("../../i18n", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en" }),
}));
vi.mock("../../components/MessageContent", () => ({
  MessageContent: ({ message }: { message: UIMessage }) => (
    <div data-testid="content">{message.id}</div>
  ),
}));
vi.mock("../../components/MessageAssistantFooter", () => ({
  MessageAssistantFooter: () => <div data-testid="footer" />,
}));

const { MessageList } = await import("./MessageList");

const user = (id: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text: id }] }) as UIMessage;

let animate: ReturnType<typeof vi.fn>;

/**
 * A transcript with synthetic geometry.
 *
 * jsdom lays nothing out, so the FLIP would measure every row at zero and
 * conclude nothing moved. Rows are given a 100px pitch by DOM order, which is
 * the same shape a real list has — and the movement is what is under test, not
 * the browser's layout.
 */
function setup(messages: UIMessage[], reduced: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduced && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  const listRef = { current: null as HTMLDivElement | null };
  const props = {
    messages,
    chatLoading: false,
    busy: false,
    agentBusy: false,
    settling: false,
    activity: null,
    interactionBusy: false,
    listRef,
    stickToBottomRef: { current: true },
    reveal: null,
    canRegenerate: true,
    onRegenerate: () => {},
    readEditError: () => undefined,
    empty: <div data-testid="empty">nothing here</div>,
  };
  const renderList = (next: UIMessage[]) =>
    render(
      <MessageList {...({ ...props, messages: next } as Parameters<typeof MessageList>[0])} />,
    );
  const view = renderList(messages);
  return {
    view,
    rerender: (next: UIMessage[]) => {
      const propsNext = { ...props, messages: next };
      view.rerender(<MessageList {...(propsNext as Parameters<typeof MessageList>[0])} />);
    },
  };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-message-id]"));
      return Math.max(0, rows.indexOf(this)) * 100;
    },
  });
  animate = vi.fn(() => ({ cancel: () => {}, finished: Promise.resolve() }));
  (Element.prototype as unknown as { animate: unknown }).animate = animate;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the answer-insertion movement", () => {
  it("plays a row's shift instead of letting the list jump", () => {
    // Two turns; then a new question lands above the answer, so the answer
    // moves down by one row (100px). FLIP inverts that: the row is drawn where
    // it was and played to where it is now.
    const { rerender } = setup([user("u1"), user("a1")], false);
    expect(animate).not.toHaveBeenCalled();

    rerender([user("u1"), user("u2"), user("a1")]);

    const shifted = animate.mock.calls.find(
      ([keyframes]) => (keyframes as Keyframe[])[0]?.transform === "translateY(-100px)",
    );
    expect(shifted, "the answer that moved was not animated from its old place").toBeTruthy();
    // And the row that merely arrived rises into place.
    const arrived = animate.mock.calls.find(
      ([keyframes]) => (keyframes as Keyframe[])[0]?.opacity === 0,
    );
    expect(arrived, "the inserted answer appeared with no arrival").toBeTruthy();
  });

  it("moves nothing when the reader asked for less motion", () => {
    const { rerender } = setup([user("u1"), user("a1")], true);
    rerender([user("u1"), user("u2"), user("a1")]);
    expect(animate).not.toHaveBeenCalled();
  });
});
