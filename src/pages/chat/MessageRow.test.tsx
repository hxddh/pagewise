// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  MessageAssistantFooter: (props: {
    live?: boolean;
    canRegenerate?: boolean;
    onKeep?: (claim: string, pages: number[], source: { body: string; messageId: string }) => void;
    onKeepVerified?: (sentences: unknown[], messageId: string) => void;
    onRegenerate?: () => void;
  }) => (
    <div data-testid="footer">
      <span data-testid="live">{String(!!props.live)}</span>
      <button
        type="button"
        data-testid="keep"
        onClick={() => props.onKeep?.("a claim", [2], { body: "the answer", messageId: "a1" })}
      >
        keep
      </button>
      <button
        type="button"
        data-testid="keep-verified"
        onClick={() => props.onKeepVerified?.([{ claim: "c", page: 2, quote: "q" }], "a1")}
      >
        keep verified
      </button>
      <button type="button" data-testid="regen" onClick={() => props.onRegenerate?.()}>
        regen
      </button>
    </div>
  ),
}));

const { MessageRow } = await import("./MessageRow");

const assistant: UIMessage = {
  id: "a1",
  role: "assistant",
  parts: [{ type: "text", text: "an answer" }],
} as UIMessage;
const question: UIMessage = {
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "what about risk?" }],
} as UIMessage;

const base = {
  live: false,
  settling: false,
  activity: null,
  canRegenerate: false,
  onRegenerate: () => {},
  readEditError: () => undefined,
  interactionBusy: false,
};

afterEach(cleanup);

describe("MessageRow", () => {
  it("draws an answer with its footer state and keeps the wiring", () => {
    const onKeep = vi.fn();
    const onKeepVerified = vi.fn();
    const onRegenerate = vi.fn();
    const view = render(
      <MessageRow
        {...base}
        message={assistant}
        live
        canRegenerate
        onKeep={onKeep}
        onKeepVerified={onKeepVerified}
        onRegenerate={onRegenerate}
      />,
    );
    expect(view.getByTestId("content").textContent).toBe("a1");
    expect(view.getByTestId("live").textContent).toBe("true");

    fireEvent.click(view.getByTestId("keep"));
    expect(onKeep).toHaveBeenCalledWith("a claim", [2], {
      body: "the answer",
      messageId: "a1",
    });
    fireEvent.click(view.getByTestId("keep-verified"));
    expect(onKeepVerified).toHaveBeenCalledWith([{ claim: "c", page: 2, quote: "q" }], "a1");
    fireEvent.click(view.getByTestId("regen"));
    expect(onRegenerate).toHaveBeenCalled();
  });

  it("offers no edit trigger without a handler, and one with it", () => {
    const view = render(<MessageRow {...base} message={question} />);
    expect(view.queryByText("agent.editMessage")).toBeNull();

    view.rerender(<MessageRow {...base} message={question} onEdit={vi.fn(async () => true)} />);
    expect(view.getByText("agent.editMessage")).toBeTruthy();
  });

  it("rewrites a question and closes the form when the resend goes", async () => {
    const onEdit = vi.fn(async () => true);
    const view = render(<MessageRow {...base} message={question} onEdit={onEdit} />);
    fireEvent.click(view.getByText("agent.editMessage"));
    const textarea = view.container.querySelector("textarea")!;
    expect((textarea as HTMLTextAreaElement).value).toBe("what about risk?");
    fireEvent.change(textarea, { target: { value: "what about cost?" } });
    fireEvent.submit(view.container.querySelector("form")!);
    await vi.waitFor(() =>
      expect(onEdit).toHaveBeenCalledWith("u1", "what about cost?"),
    );
    await vi.waitFor(() => expect(view.container.querySelector("textarea")).toBeNull());
  });

  it("shows the provider's own error when the resend fails", async () => {
    const view = render(
      <MessageRow
        {...base}
        message={question}
        onEdit={vi.fn(async () => false)}
        readEditError={() => "the provider said no"}
      />,
    );
    fireEvent.click(view.getByText("agent.editMessage"));
    fireEvent.submit(view.container.querySelector("form")!);
    await vi.waitFor(() => expect(view.getByRole("alert").textContent).toBe("the provider said no"));
  });

  it("refuses to resubmit while something is running", () => {
    const onEdit = vi.fn(async () => true);
    const view = render(
      <MessageRow {...base} message={question} onEdit={onEdit} interactionBusy />,
    );
    expect(view.queryByText("agent.editMessage")).toBeNull();
  });
});
