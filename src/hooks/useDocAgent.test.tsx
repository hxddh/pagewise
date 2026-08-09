// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";

/**
 * The invariants `useDocAgent` holds, which until now only its comments claimed.
 *
 * This is the hook every message goes through — send, edit, regenerate, steer,
 * the optimistic user row and its rollback, persistence, and three generation
 * counters that keep a late chunk from one document out of the next one. 657
 * lines, and `src/hooks` had one test file for all 1,954 of its lines.
 *
 * That matters because of where the bugs have actually been found. Of the last
 * six I dug out, five were in `src/lib` — not because that is where bugs live,
 * but because that is where a test can show one. All three the reader reported
 * were in layers with no tests at all.
 *
 * So these are not coverage. Each one turns a promise written in a comment into
 * an assertion that fails when the promise is broken.
 */

const h = vi.hoisted(() => ({
  /** The last options object `useChat` was constructed with, so its callbacks
   *  can be fired the way the SDK would fire them. */
  chatOptions: null as Record<string, unknown> | null,
  messages: [] as UIMessage[],
  status: "ready" as string,
  sendMessage: vi.fn(async (_payload?: unknown) => {}),
  stop: vi.fn(),
  error: undefined as Error | undefined,
  settings: { provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test" } as Record<
    string,
    unknown
  >,
  steerQueued: null as string | null,
  sendCalls: [] as unknown[],
  /** Every per-message context handed to the agent, newest last. */
  contexts: [] as unknown[],
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: (options: Record<string, unknown>) => {
    h.chatOptions = options;
    return {
      messages: h.messages,
      status: h.status,
      error: h.error,
      sendMessage: async (payload: unknown) => {
        h.sendCalls.push(payload);
        return h.sendMessage(payload as never);
      },
      stop: h.stop,
      setMessages: (updater: unknown) => {
        h.messages =
          typeof updater === "function"
            ? (updater as (p: UIMessage[]) => UIMessage[])(h.messages)
            : (updater as UIMessage[]);
      },
      clearError: () => {
        h.error = undefined;
      },
    };
  },
}));

vi.mock("../lib/agent", () => ({ createDocAgent: () => ({ tools: {} }) }));
vi.mock("../lib/pagewise-chat-transport", () => ({
  PagewiseChatTransport: class {},
}));
vi.mock("../lib/settings", () => ({ loadSettings: async () => h.settings }));
vi.mock("../lib/llm", () => ({
  formatAgentError: (e: unknown) => String(e),
  validateModel: () => undefined,
  assertApiKeyForAgent: () => {},
}));
vi.mock("../lib/pdf", () => ({ capturePageFilePart: async () => null }));
vi.mock("../lib/agent-abort", () => ({ clearAgentRunAbortSignal: vi.fn() }));
vi.mock("../i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));
vi.mock("../lib/agent-steer", () => ({
  steerCurrentRun: (_text: string) => h.steerQueued,
}));
vi.mock("../lib/agent-view-context", () => ({
  beginAgentMessage: (ctx: unknown) => h.contexts.push(ctx),
  rollbackAgentMessage: vi.fn(),
}));
vi.mock("../lib/agent-send", () => ({
  // The real one retries without the image on an image error. These tests are
  // about the hook's own bookkeeping, so it just forwards once.
  sendWithImageFallback: async (
    payload: unknown,
    send: (p: unknown) => Promise<void>,
  ) => {
    await send(payload);
  },
}));

const { useDocAgent } = await import("./useDocAgent");

type Agent = ReturnType<typeof useDocAgent>;

function mount(chatId = "doc-a") {
  const captured: { current: Agent | null } = { current: null };
  function Probe({ id }: { id: string }) {
    captured.current = useDocAgent(id);
    return null;
  }
  const view = render(<Probe id={chatId} />);
  return {
    agent: () => captured.current!,
    switchTo: (id: string) => view.rerender(<Probe id={id} />),
  };
}

const user = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;
const assistant = (id: string, text: string): UIMessage =>
  ({ id, role: "assistant", parts: [{ type: "text", text }] }) as UIMessage;

const lastContext = () =>
  h.contexts[h.contexts.length - 1] as Record<string, unknown> | undefined;

const OPTS = {
  text: "what about risk?",
  path: "/docs/a.pdf",
  docName: "a.pdf",
  docKind: "pdf" as const,
  viewingPage: 3,
  totalPages: 40,
  includeViewingPage: false,
};

beforeEach(() => {
  h.chatOptions = null;
  h.messages = [];
  h.status = "ready";
  h.error = undefined;
  h.sendMessage = vi.fn(async (_payload?: unknown) => {});
  h.stop = vi.fn();
  h.steerQueued = "page 40, not 4";
  h.sendCalls.length = 0;
  h.contexts.length = 0;
});
afterEach(cleanup);

describe("steerRun", () => {
  it("records the correction on the turn that started the run", () => {
    // Queueing it for the model without recording it means the composer clears,
    // the answer changes, and the transcript never says why.
    h.messages = [user("u1", "what about risk?"), assistant("a1", "reading…")];
    const { agent } = mount();

    act(() => {
      expect(agent().steerRun("page 40, not 4")).toBe(true);
    });

    const turn = h.messages.find((m) => m.id === "u1")!;
    expect(turn.parts).toHaveLength(2);
    expect((turn.parts[1] as { text: string }).text).toBe("page 40, not 4");
    // The assistant turn is untouched — the correction is something the reader
    // said, not something the agent did.
    expect(h.messages.find((m) => m.id === "a1")!.parts).toHaveLength(1);
  });

  it("attaches to the newest user turn, not the first", () => {
    h.messages = [
      user("u1", "first question"),
      assistant("a1", "first answer"),
      user("u2", "second question"),
    ];
    const { agent } = mount();
    act(() => agent().steerRun("actually page 12"));
    expect(h.messages.find((m) => m.id === "u1")!.parts).toHaveLength(1);
    expect(h.messages.find((m) => m.id === "u2")!.parts).toHaveLength(2);
  });

  it("changes nothing when the run refuses the correction", () => {
    // MAX_STEER_NOTES reached. Half-applying it — a transcript entry for a note
    // the model never sees — would be worse than refusing.
    h.steerQueued = null;
    h.messages = [user("u1", "what about risk?")];
    const { agent } = mount();

    act(() => {
      expect(agent().steerRun("one too many")).toBe(false);
    });
    expect(h.messages[0]!.parts).toHaveLength(1);
  });

  it("does nothing to a conversation with no question in it yet", () => {
    h.messages = [];
    const { agent } = mount();
    act(() => agent().steerRun("a correction with nothing to correct"));
    expect(h.messages).toEqual([]);
  });
});

describe("switching documents", () => {
  it("drops the previous document's per-message options", async () => {
    // These carry "send the page screenshot" and "use web search". They are
    // remembered so a Retry re-runs the same way — but the memory has to end
    // with the document, or A's choices silently apply to B's Regenerate.
    h.messages = [user("u1", "question about A"), assistant("a1", "answer")];
    const { agent, switchTo } = mount("doc-a");

    await act(async () => {
      await agent().sendDocumentMessage({
        ...OPTS,
        includeViewingPage: true,
        webSearch: true,
      });
    });
    expect(lastContext()).toMatchObject({ includeViewingPage: true, webSearch: true });

    switchTo("doc-b");
    h.messages = [user("u2", "question about B")];
    h.contexts.length = 0;

    await act(async () => {
      await agent().regenerateDocumentMessage({
        ...OPTS,
        path: "/docs/b.pdf",
        docName: "b.pdf",
        includeViewingPage: false,
        webSearch: false,
      });
    });

    // B's own choices, not the ones remembered from A.
    expect(lastContext()).toMatchObject({ includeViewingPage: false, webSearch: false });
  });

  it("still reuses this document's options for a regenerate", async () => {
    // The other half: clearing on switch must not break the thing the memory is
    // for. A Retry of a web-enabled question has to run with web search again,
    // or the answer silently changes.
    h.messages = [user("u1", "question about A"), assistant("a1", "answer")];
    const { agent } = mount("doc-a");

    await act(async () => {
      await agent().sendDocumentMessage({ ...OPTS, includeViewingPage: true, webSearch: true });
    });
    h.contexts.length = 0;

    await act(async () => {
      await agent().regenerateDocumentMessage({
        ...OPTS,
        includeViewingPage: false,
        webSearch: false,
      });
    });
    expect(lastContext()).toMatchObject({ includeViewingPage: true, webSearch: true });
  });

  it("stops whatever the previous document was doing", () => {
    const { switchTo } = mount("doc-a");
    h.stop.mockClear();
    switchTo("doc-b");
    expect(h.stop).toHaveBeenCalled();
  });

  it("ignores a progress line that arrives after the switch", () => {
    // onData is guarded on the generation counter. Without it, a buffered chunk
    // from document A sets an activity line under document B's conversation.
    const { agent, switchTo } = mount("doc-a");
    const onData = h.chatOptions!.onData as (part: unknown) => void;

    switchTo("doc-b");
    act(() => {
      onData({ type: "data-agent-progress", data: { message: "Reading page 7…" } });
    });

    expect(agent().streamProgress).toBeNull();
  });
});

describe("refusing to start a second run", () => {
  it("will not send while one is streaming", async () => {
    h.status = "streaming";
    const { agent } = mount();
    let result: boolean | undefined;
    await act(async () => {
      result = await agent().sendDocumentMessage(OPTS);
    });
    expect(result).toBe(false);
    expect(h.sendCalls).toHaveLength(0);
  });

  it("will not edit a message while one is streaming", async () => {
    h.status = "streaming";
    h.messages = [user("u1", "q")];
    const { agent } = mount();
    let result: boolean | undefined;
    await act(async () => {
      result = await agent().editUserMessage?.("u1", OPTS);
    });
    expect(result).toBe(false);
    expect(h.sendCalls).toHaveLength(0);
  });
});

describe("regenerate", () => {
  it("re-asks the last question rather than an empty one", async () => {
    h.messages = [user("u1", "what about risk?"), assistant("a1", "an answer")];
    const { agent } = mount();
    await act(async () => {
      await agent().regenerateDocumentMessage(OPTS);
    });
    expect(h.sendCalls).toHaveLength(1);
    expect(h.sendCalls[0]).toMatchObject({ messageId: "u1" });
  });

  it("refuses when there is no question to re-ask", async () => {
    h.messages = [];
    const { agent } = mount();
    let result: boolean | undefined;
    await act(async () => {
      result = await agent().regenerateDocumentMessage(OPTS);
    });
    expect(result).toBe(false);
    expect(h.sendCalls).toHaveLength(0);
  });

  it("refuses when the last question is only whitespace", async () => {
    h.messages = [user("u1", "   ")];
    const { agent } = mount();
    let result: boolean | undefined;
    await act(async () => {
      result = await agent().regenerateDocumentMessage(OPTS);
    });
    expect(result).toBe(false);
  });

  it("cuts the stale answer off before re-asking", async () => {
    // The old assistant turn has to go, or the regenerated one lands beneath a
    // reply to the same question.
    h.messages = [
      user("u1", "what about risk?"),
      assistant("a1", "the answer being replaced"),
    ];
    const { agent } = mount();
    await act(async () => {
      await agent().regenerateDocumentMessage(OPTS);
    });
    expect(h.messages.map((m) => m.id)).toEqual(["u1"]);
  });
});
