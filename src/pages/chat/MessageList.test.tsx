// @vitest-environment jsdom
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
const assistant = (id: string): UIMessage =>
  ({ id, role: "assistant", parts: [{ type: "text", text: id }] }) as UIMessage;

function setup(overrides: Record<string, unknown> = {}) {
  const listRef = { current: null as HTMLDivElement | null };
  const stickToBottomRef = { current: true };
  const props = {
    messages: [user("u1"), assistant("a1")],
    chatLoading: false,
    busy: false,
    agentBusy: false,
    settling: false,
    activity: null,
    interactionBusy: false,
    listRef,
    stickToBottomRef,
    reveal: null,
    canRegenerate: true,
    onRegenerate: () => {},
    readEditError: () => undefined,
    empty: <div data-testid="empty">nothing here</div>,
    ...overrides,
  };
  const view = render(<MessageList {...(props as Parameters<typeof MessageList>[0])} />);
  return { view, listRef };
}

beforeEach(() => {
  // jsdom does not implement scrollIntoView; the reveal path calls it.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe("MessageList", () => {
  it("draws one row per turn, in order", () => {
    const { view } = setup();
    const rows = view.container.querySelectorAll(".message");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute("data-message-id")).toBe("u1");
    expect(rows[1]!.getAttribute("data-message-id")).toBe("a1");
  });

  it("shows the empty state only when there is nothing to show and nothing loading", () => {
    const { view } = setup({ messages: [] });
    expect(view.getByTestId("empty")).toBeTruthy();
  });

  it("shows the history spinner while the transcript is being read", () => {
    const { view } = setup({ messages: [], chatLoading: true });
    expect(view.getByText("agent.loadingHistory")).toBeTruthy();
    expect(view.queryByTestId("empty")).toBeNull();
  });

  it("shows the in-progress line while a run has not written a turn yet", () => {
    const { view } = setup({ messages: [user("u1")], agentBusy: true, activity: "reading page 3" });
    expect(view.getByText("reading page 3")).toBeTruthy();
  });

  it("scrolls to and focuses the turn a record entry points back at", async () => {
    const { view } = setup({ reveal: { id: "u1", nonce: 1 } });
    const row = view.container.querySelector<HTMLElement>('[data-message-id="u1"]')!;
    await vi.waitFor(() => expect(document.activeElement).toBe(row));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});
