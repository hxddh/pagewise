// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../i18n", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en" }),
}));

const { Composer } = await import("./Composer");

const base = {
  busy: false,
  agentBusy: false,
  loading: false,
  hasApiKey: true,
  hasDocument: true,
  webSearchAvailable: false,
  onStop: () => {},
  onConfigureApi: () => {},
};

function setup(overrides: Record<string, unknown> = {}) {
  const onSend = vi.fn(async () => true);
  const onDraftChange = vi.fn();
  const textareaRef = { current: null as HTMLTextAreaElement | null };
  const props = {
    draft: "what about risk?",
    onDraftChange,
    onSend,
    ...base,
    ...overrides,
    textareaRef,
  };
  const view = render(<Composer {...(props as Parameters<typeof Composer>[0])} />);
  const textarea = view.container.querySelector("textarea")!;
  return { view, textarea, onSend, onDraftChange };
}

const pressEnter = (textarea: HTMLElement) =>
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe("Composer", () => {
  it("sends on Enter and leaves Shift+Enter to the textarea", async () => {
    const { textarea, onSend } = setup();
    pressEnter(textarea);
    await vi.waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("what about risk?", { webSearch: false }),
    );

    onSend.mockClear();
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("says nothing to send when the draft is blank", () => {
    const { view, textarea } = setup({ draft: "   " });
    expect((view.getByText("agent.send") as HTMLButtonElement).disabled).toBe(true);
    pressEnter(textarea);
    expect(view.getByText("agent.send")).toBeTruthy();
  });

  it("turns Stop into Steer once the reader types during a run", () => {
    const onStop = vi.fn();
    const { view } = setup({ busy: true, draft: "", onStop });
    fireEvent.click(view.getByText("agent.stop"));
    expect(onStop).toHaveBeenCalled();

    view.rerender(
      <Composer
        {...({
          draft: "page 40, not 4",
          onDraftChange: () => {},
          onSend: async () => true,
          ...base,
          busy: true,
          textareaRef: { current: null },
        } as Parameters<typeof Composer>[0])}
      />,
    );
    expect(view.getByText("agent.steer")).toBeTruthy();
  });

  it("offers the web toggle only where the provider can search, and spends it per message", async () => {
    const { view, textarea, onSend } = setup({ webSearchAvailable: true });
    const toggle = view.getByLabelText("agent.webSearchOff");
    fireEvent.click(toggle);
    expect(view.getByLabelText("agent.webSearchOn").getAttribute("aria-pressed")).toBe("true");

    pressEnter(textarea);
    await vi.waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("what about risk?", { webSearch: true }),
    );
    // Spent on the message that went; a new one starts off.
    await vi.waitFor(() =>
      expect(view.getByLabelText("agent.webSearchOff").getAttribute("aria-pressed")).toBe("false"),
    );
  });

  it("re-arms the web choice when the send does not go", async () => {
    const { view, textarea } = setup({
      webSearchAvailable: true,
      onSend: vi.fn(async () => false),
    });
    fireEvent.click(view.getByLabelText("agent.webSearchOff"));
    pressEnter(textarea);
    await vi.waitFor(() =>
      expect(view.getByLabelText("agent.webSearchOn").getAttribute("aria-pressed")).toBe("true"),
    );
  });

  it("says the keyboard line once and clears it when a send goes", async () => {
    const { view, textarea } = setup();
    expect(view.getByText("agent.hint")).toBeTruthy();
    pressEnter(textarea);
    await vi.waitFor(() => expect(view.queryByText("agent.hint")).toBeNull());
    expect(localStorage.getItem("pagewise.hint.composer")).toBe("1");
  });
});
