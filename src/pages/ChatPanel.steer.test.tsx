// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import type React from "react";

/**
 * What sending during a run does.
 *
 * `ChatPanel.tsx` is 718 lines and had no test at all — the largest untested
 * file in the app, and `submit` is the branchiest thing in it. Every bug the
 * reader has reported in this app was in a component, which is the layer with
 * six tests to `src/lib`'s fifty-four; the difference is not where the bugs are,
 * it is where a test can show them.
 *
 * This pins the one contract 7.6 changed: a correction typed mid-run goes to the
 * run that is going, and does not start a new one. Getting that backwards is
 * invisible in the UI — the answer still changes, it just costs a full re-read.
 */

const h = vi.hoisted(() => ({ reclaimed: [] as string[] }));

vi.mock("../lib/agent-steer", () => ({
  reclaimUndeliveredNotes: () => h.reclaimed.splice(0, h.reclaimed.length),
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
  path: "/docs/report.pdf",
  name: "report.pdf",
  kind: "pdf" as const,
  totalPages: 40,
  pages: [],
};

const messages: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "what about risk?" }] } as UIMessage,
];

function setup(overrides: Record<string, unknown> = {}) {
  const send = vi.fn(async () => true);
  const steer = vi.fn(() => true);
  const onDraftChange = vi.fn();
  const props = {
    activeDoc: doc,
    previewPage: 1,
    includeViewingPage: false,
    messages,
    sendDocumentMessage: send,
    status: "streaming" as const,
    error: undefined,
    hasApiKey: true,
    settingsReady: true,
    loadingDoc: false,
    activity: null,
    composerDraft: "page 40, not 4",
    onComposerDraftChange: onDraftChange,
    onConfigureApi: vi.fn(),
    onStop: vi.fn(),
    waitForStreamIdle: vi.fn(async () => true),
    steerRun: steer,
    onClearChat: vi.fn(),
    onExportChat: vi.fn(),
    onExportSummary: vi.fn(),
    ...overrides,
  };
  const view = render(<ChatPanel {...(props as unknown as React.ComponentProps<typeof ChatPanel>)} />);
  const textarea = view.container.querySelector("textarea")!;
  return { view, textarea, send, steer, onDraftChange };
}

const submit = (textarea: HTMLElement) =>
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

beforeEach(() => {
  h.reclaimed.length = 0;
});
afterEach(cleanup);

describe("sending while the agent is working", () => {
  it("hands the text to the running agent instead of starting a new run", () => {
    const { textarea, send, steer } = setup();
    submit(textarea);
    expect(steer).toHaveBeenCalledWith("page 40, not 4");
    // The whole point: no second run. Restarting re-reads every page the first
    // run had already paid for.
    expect(send).not.toHaveBeenCalled();
  });

  it("clears the composer once the correction is on its way", () => {
    const { textarea, onDraftChange } = setup();
    submit(textarea);
    expect(onDraftChange).toHaveBeenCalledWith("");
  });

  it("falls back to a fresh run when the agent will not take the correction", async () => {
    // MAX_STEER_NOTES reached, or no run to inject into. Dropping what was typed
    // is the one outcome that is never acceptable. The fallback stops the stream
    // first, so this has to let those promises settle.
    const { textarea, send } = setup({ steerRun: vi.fn(() => false) });
    submit(textarea);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
  });

  it("sends normally when nothing is running", async () => {
    const { textarea, send, steer } = setup({ status: "ready" as const });
    submit(textarea);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(steer).not.toHaveBeenCalled();
  });

  it("asks for an API key rather than silently swallowing the correction", () => {
    const onConfigureApi = vi.fn();
    const { textarea, steer } = setup({ hasApiKey: false, onConfigureApi });
    submit(textarea);
    expect(onConfigureApi).toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
  });

  it("puts a correction that arrived too late back in the composer", () => {
    // The run ended before a step could carry it. Losing the reader's words is
    // worse than handing them back.
    h.reclaimed.push("page 40, not 4");
    const { onDraftChange } = setup({ status: "ready" as const, composerDraft: "" });
    expect(onDraftChange).toHaveBeenCalledWith("page 40, not 4");
  });

  it("does not overwrite something newer the reader has already typed", () => {
    h.reclaimed.push("stale correction");
    const { onDraftChange } = setup({
      status: "ready" as const,
      composerDraft: "a new question",
    });
    expect(onDraftChange).not.toHaveBeenCalledWith("stale correction");
  });
});
