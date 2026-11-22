import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ChatStatus } from "ai";
import type {
  DocAgent,
  RegenerateDocumentMessageOptions,
  SendDocumentMessageOptions,
} from "../hooks/useDocAgent";
import type { PageWiseUIMessage } from "../lib/message-metadata";

type UseDocAgentFn = typeof import("../hooks/useDocAgent").useDocAgent;

interface AgentStateSnapshot {
  messages: PageWiseUIMessage[];
  status: ChatStatus;
  error: Error | undefined;
  errorMessage: string | undefined;
  progress: string | null;
  busy: boolean;
  settling: boolean;
  chatId: string;
}

let hookPromise: Promise<UseDocAgentFn> | null = null;
let resolvedHook: UseDocAgentFn | null = null;

function loadUseDocAgent(): Promise<UseDocAgentFn> {
  if (resolvedHook) return Promise.resolve(resolvedHook);
  hookPromise ??= import("../hooks/useDocAgent")
    .then((m) => {
      resolvedHook = m.useDocAgent;
      return m.useDocAgent;
    })
    .catch((err) => {
      hookPromise = null;
      throw err;
    });
  return hookPromise;
}

function sameSnapshot(a: AgentStateSnapshot | null, b: AgentStateSnapshot): boolean {
  return (
    a !== null &&
    a.messages === b.messages &&
    a.status === b.status &&
    a.error === b.error &&
    a.errorMessage === b.errorMessage &&
    a.progress === b.progress &&
    a.busy === b.busy &&
    a.settling === b.settling &&
    a.chatId === b.chatId
  );
}

function ActiveDocAgentHost({
  useDocAgentImpl,
  chatId,
  liveAgentRef,
  stagedMessagesRef,
  onSnapshotChange,
}: {
  useDocAgentImpl: UseDocAgentFn;
  chatId: string;
  liveAgentRef: React.MutableRefObject<DocAgent | null>;
  stagedMessagesRef: React.MutableRefObject<
    { chatId: string; messages: PageWiseUIMessage[] } | null
  >;
  onSnapshotChange: (snap: AgentStateSnapshot) => void;
}) {
  const agent = useDocAgentImpl(chatId);
  liveAgentRef.current = agent;
  const busy = agent.run.isBusy();

  useLayoutEffect(() => {
    liveAgentRef.current = agent;
    const staged = stagedMessagesRef.current;
    if (staged && staged.chatId === chatId) {
      stagedMessagesRef.current = null;
      agent.messages.set(staged.messages);
    }
    onSnapshotChange({
      messages: agent.messages.list,
      status: agent.run.status,
      error: agent.run.error,
      errorMessage: agent.run.errorMessage,
      progress: agent.run.progress,
      busy,
      settling: agent.history.settling,
      chatId: agent.history.chatId,
    });
  }, [
    agent,
    busy,
    chatId,
    onSnapshotChange,
    stagedMessagesRef,
  ]);

  useEffect(
    () => () => {
      liveAgentRef.current = null;
    },
    [liveAgentRef],
  );

  return null;
}

/**
 * Defers loading `@ai-sdk/react` + `ai` (~503 KB) + `zod` (~390 KB) until after
 * cold-boot WelcomeView has painted (or immediately when a document opens), while
 * preserving unconditional hook semantics inside `ActiveDocAgentHost`.
 */
export function useLazyDocAgent(
  chatId: string,
  activeImmediately: boolean,
): { agent: DocAgent; agentHost: ReactNode } {
  const [hookImpl, setHookImpl] = useState<UseDocAgentFn | null>(() => resolvedHook);
  const [snapshot, setSnapshot] = useState<AgentStateSnapshot | null>(null);
  const liveAgentRef = useRef<DocAgent | null>(null);
  const stagedMessagesRef = useRef<{ chatId: string; messages: PageWiseUIMessage[] } | null>(
    null,
  );
  const [fallbackMessages, setFallbackMessages] = useState<PageWiseUIMessage[]>([]);

  const handleSnapshotChange = useCallback((next: AgentStateSnapshot) => {
    setSnapshot((prev) => (sameSnapshot(prev, next) ? prev : next));
  }, []);

  useEffect(() => {
    if (hookImpl) return;
    let cancelled = false;
    const trigger = () => {
      void loadUseDocAgent()
        .then((fn) => {
          if (!cancelled) setHookImpl(() => fn);
        })
        .catch(() => {});
    };
    if (activeImmediately) {
      trigger();
      return () => {
        cancelled = true;
      };
    }
    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const id = window.requestIdleCallback(trigger, { timeout: 1500 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback(id);
      };
    }
    const timer = globalThis.setTimeout(trigger, 400);
    return () => {
      cancelled = true;
      globalThis.clearTimeout(timer);
    };
  }, [activeImmediately, hookImpl]);

  const setMessages = useCallback<DocAgent["messages"]["set"]>(
    (updater) => {
      if (liveAgentRef.current) {
        liveAgentRef.current.messages.set(updater);
        return;
      }
      setFallbackMessages((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        stagedMessagesRef.current = { chatId, messages: next };
        return next;
      });
    },
    [chatId],
  );

  const waitForLiveAgent = useCallback(async (): Promise<DocAgent | null> => {
    if (liveAgentRef.current) return liveAgentRef.current;
    const fn = await loadUseDocAgent();
    setHookImpl(() => fn);
    for (let i = 0; i < 30 && !liveAgentRef.current; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return liveAgentRef.current;
  }, []);

  const agent = useMemo<DocAgent>(
    () => ({
      messages: {
        list: snapshot ? snapshot.messages : fallbackMessages,
        set: setMessages,
        clear: () => {
          stagedMessagesRef.current = null;
          setFallbackMessages([]);
          liveAgentRef.current?.messages.clear();
        },
      },
      run: {
        status: snapshot ? snapshot.status : "ready",
        error: snapshot?.error,
        errorMessage: snapshot?.errorMessage,
        progress: snapshot ? snapshot.progress : null,
        isBusy: () => liveAgentRef.current?.run.isBusy() ?? false,
        send: async (opts: SendDocumentMessageOptions) => {
          const a = await waitForLiveAgent();
          return a ? a.run.send(opts) : false;
        },
        edit: async (id: string, opts: SendDocumentMessageOptions) => {
          const a = await waitForLiveAgent();
          return a ? a.run.edit(id, opts) : false;
        },
        regenerate: async (opts: RegenerateDocumentMessageOptions) => {
          const a = await waitForLiveAgent();
          return a ? a.run.regenerate(opts) : false;
        },
        stop: () => liveAgentRef.current?.run.stop(),
        steer: (text: string) => liveAgentRef.current?.run.steer(text) ?? false,
        waitForIdle: async () =>
          liveAgentRef.current ? liveAgentRef.current.run.waitForIdle() : true,
        clearError: () => liveAgentRef.current?.run.clearError(),
        reset: () => {
          stagedMessagesRef.current = null;
          setFallbackMessages([]);
          liveAgentRef.current?.run.reset();
        },
        abort: () => liveAgentRef.current?.run.abort(),
      },
      history: {
        settling: snapshot ? snapshot.settling : false,
        chatId: snapshot ? snapshot.chatId : chatId,
      },
    }),
    [chatId, fallbackMessages, setMessages, snapshot, waitForLiveAgent],
  );

  const agentHost = hookImpl ? (
    <ActiveDocAgentHost
      useDocAgentImpl={hookImpl}
      chatId={chatId}
      liveAgentRef={liveAgentRef}
      stagedMessagesRef={stagedMessagesRef}
      onSnapshotChange={handleSnapshotChange}
    />
  ) : null;

  return {
    agent,
    agentHost,
  };
}
