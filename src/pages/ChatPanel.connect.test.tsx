// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type React from "react";

/**
 * A document open and no provider connected (24.0).
 *
 * The panel was one grey line, the composer's button read "Configure AI", and
 * Enter opened Settings and left it at that — the reader had to come back and
 * send again. What is pinned here: the empty state says what works and offers
 * one way to connect; a question asked before connecting stays in the box and
 * goes out by itself, once, after a provider is connected and Settings closes;
 * cancelling Settings sends nothing.
 */

vi.mock("../lib/agent-steer", () => ({
  reclaimUndeliveredNotes: () => [],
}));
vi.mock("../i18n", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en" }),
}));
vi.mock("../lib/mark-store", () => ({ getMarks: () => [] }));
vi.mock("../components/MessageContent", () => ({
  MessageContent: () => null,
}));
vi.mock("../components/MessageAssistantFooter", () => ({
  MessageAssistantFooter: () => null,
}));

const { ChatPanel } = await import("./ChatPanel");

const doc = {
  path: "/docs/lease.pdf",
  name: "lease.pdf",
  kind: "pdf" as const,
  totalPages: 12,
  pages: [],
};

const QUESTION = "when does the lease end?";

interface State {
  hasApiKey: boolean;
  settingsOpen: boolean;
  composerDraft: string;
}

function setup(initial: Partial<State> = {}) {
  const send = vi.fn(async () => true);
  const onConfigureApi = vi.fn();
  const onDraftChange = vi.fn();
  let state: State = {
    hasApiKey: false,
    settingsOpen: false,
    composerDraft: QUESTION,
    ...initial,
  };
  const agent = {
    messages: { list: [], set: vi.fn(), clear: vi.fn() },
    run: {
      status: "ready" as const,
      error: undefined,
      errorMessage: undefined,
      progress: null,
      isBusy: () => false,
      send,
      edit: vi.fn(async () => true),
      regenerate: vi.fn(async () => true),
      stop: vi.fn(),
      steer: vi.fn(() => true),
      waitForIdle: vi.fn(async () => true),
      clearError: vi.fn(),
      reset: vi.fn(),
      abort: vi.fn(),
    },
    history: { settling: false, chatId: "pagewise-local" },
  };
  const element = () => {
    const props = {
      doc,
      page: 1,
      includeViewingPage: false,
      agent,
      connection: {
        hasApiKey: state.hasApiKey,
        agentToolsSupported: true,
        webSearchAvailable: false,
        settingsReady: true,
      },
      session: { loading: false, chatLoading: false },
      composerDraft: state.composerDraft,
      onComposerDraftChange: onDraftChange,
      panel: { tab: "chat" as const, setTab: vi.fn(), revision: 0 },
      reveal: {},
      scan: { count: 0 },
      onConfigureApi,
      settingsOpen: state.settingsOpen,
    };
    return <ChatPanel {...(props as unknown as React.ComponentProps<typeof ChatPanel>)} />;
  };
  const view = render(element());
  const update = (patch: Partial<State>) => {
    state = { ...state, ...patch };
    view.rerender(element());
  };
  const textarea = () => view.container.querySelector("textarea")!;
  const pressEnter = () => fireEvent.keyDown(textarea(), { key: "Enter", shiftKey: false });
  return { view, send, onConfigureApi, onDraftChange, update, textarea, pressEnter };
}

// Lets the composer's async submit and the panel's effects settle.
const settle = () => act(async () => {});

afterEach(cleanup);

describe("chat with a document open and no provider", () => {
  it("shows what works, one Connect button, and what will be sent", () => {
    const { onConfigureApi } = setup({ composerDraft: "" });
    expect(screen.getByText("empty.connectLead")).toBeTruthy();
    expect(screen.getByText("empty.worksWithoutAi")).toBeTruthy();
    expect(screen.getByText("empty.whatIsSent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "empty.connectAi" }));
    expect(onConfigureApi).toHaveBeenCalledTimes(1);
    // The composer's own "Configure AI" is gone: one control for one action.
    expect(screen.queryByText("agent.configureApiCta")).toBeNull();
  });

  it("keeps a question asked before connecting, and sends it once after", async () => {
    const { send, onConfigureApi, onDraftChange, update, textarea, pressEnter } = setup();
    pressEnter();
    await settle();
    expect(onConfigureApi).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    // Not lost: the composer was never emptied, and the panel says it waits.
    expect(onDraftChange).not.toHaveBeenCalledWith("");
    expect(textarea().value).toBe(QUESTION);
    expect(screen.getByText("empty.questionQueued")).toBeTruthy();

    // Settings opens; a key autosaves while it is still on screen. Nothing
    // goes yet — the reader may still be typing it.
    update({ settingsOpen: true });
    update({ hasApiKey: true });
    await settle();
    expect(send).not.toHaveBeenCalled();

    update({ settingsOpen: false });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: QUESTION, path: doc.path }));

    // Later renders do not send it again.
    update({ composerDraft: QUESTION });
    update({ settingsOpen: true });
    update({ settingsOpen: false });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends it when the connection lands just after Settings closes", async () => {
    // The setup page saves, asks for a refresh and closes; the refresh
    // resolves after the close.
    const { send, update, pressEnter } = setup();
    pressEnter();
    await settle();
    update({ settingsOpen: true });
    update({ settingsOpen: false });
    await settle();
    expect(send).not.toHaveBeenCalled();
    update({ hasApiKey: true });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("cancelling Settings keeps the question in the composer and sends nothing", async () => {
    const { send, onDraftChange, update, textarea, pressEnter } = setup();
    pressEnter();
    await settle();
    update({ settingsOpen: true });
    update({ settingsOpen: false });
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(onDraftChange).not.toHaveBeenCalledWith("");
    expect(textarea().value).toBe(QUESTION);
  });

  it("drops the queued question once the reader changes it", async () => {
    const { send, update, pressEnter } = setup();
    pressEnter();
    await settle();
    update({ settingsOpen: true });
    update({ settingsOpen: false });
    update({ composerDraft: "something else entirely" });
    await settle();
    expect(screen.queryByText("empty.questionQueued")).toBeNull();
    update({ hasApiKey: true });
    await settle();
    expect(send).not.toHaveBeenCalled();
  });
});
