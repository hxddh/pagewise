import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { beginAgentMessage, rollbackLastAgentMessage, type AgentMessageContext } from "../lib/agent-view-context";
import { sendWithImageFallback } from "../lib/agent-send";
import { createDocAgent } from "../lib/agent";
import { isAgentProgressDataPart } from "../lib/inject-progress-stream";
import { formatAgentError, validateModel, assertApiKeyForAgent } from "../lib/llm";
import { isAgentMultimodalModel } from "../lib/model-capabilities";
import {
  extractUserText,
  findLastMessage,
  sanitizeMessagesForChat,
  stripUserFileParts,
} from "../lib/messages-utils";
import { getPageWiseMetadata, type PageWiseUIMessage } from "../lib/message-metadata";
import { PagewiseChatTransport } from "../lib/pagewise-chat-transport";
import { clearAgentRunAbortSignal } from "../lib/agent-abort";
import { capturePageFilePart } from "../lib/pdf";
import {
  pruneToolOutputsForHistory,
  sanitizeDanglingToolParts,
} from "../lib/prune-chat-history";
import { loadSettings } from "../lib/settings";
import { useI18n } from "../i18n";
import { waitForStreamIdle } from "../lib/agent-stream-idle";

export interface SendDocumentMessageOptions {
  text: string;
  path: string;
  docName: string;
  docKind: "pdf" | "image";
  viewingPage: number;
  totalPages: number;
  includeViewingPage: boolean;
}

export type RegenerateDocumentMessageOptions = Omit<SendDocumentMessageOptions, "text">;

function createTransport(
  agent: ReturnType<typeof createDocAgent>,
  onError: (error: unknown) => string,
  onMessagesRepaired?: (messages: PageWiseUIMessage[]) => void,
) {
  return new PagewiseChatTransport({
    agent,
    onError,
    onMessagesRepaired,
    resolveModelLabel: async () => {
      const settings = await loadSettings();
      return settings.model?.trim() || settings.provider;
    },
    resolveProvider: async () => (await loadSettings()).provider,
  });
}

export function useDocAgent(chatId: string | null = null) {
  const { t } = useI18n();

  const agentRef = useRef<ReturnType<typeof createDocAgent> | null>(null);
  if (agentRef.current === null) {
    agentRef.current = createDocAgent();
  }

  const formatErrorRef = useRef<(error: unknown) => string>((error) =>
    formatAgentError(error),
  );
  formatErrorRef.current = (error) => formatAgentError(error, t);

  const transportRef = useRef<ReturnType<typeof createTransport> | null>(null);
  const agentGenRef = useRef(0);
  const streamAgentGenRef = useRef(0);
  if (transportRef.current === null) {
    transportRef.current = createTransport(
      agentRef.current,
      (error) => formatErrorRef.current(error),
      (repaired) => {
        if (streamAgentGenRef.current !== agentGenRef.current) return;
        setMessagesRef.current?.(repaired);
      },
    );
  }

  const setMessagesRef = useRef<
    ReturnType<typeof useChat<PageWiseUIMessage>>["setMessages"] | null
  >(null);
  const messagesRef = useRef<PageWiseUIMessage[]>([]);

  const [streamProgress, setStreamProgress] = useState<string | null>(null);
  const resolvedChatId = chatId ?? "pagewise-local";
  const pruneChatIdRef = useRef(resolvedChatId);
  const pruneTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pruneInnerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  pruneChatIdRef.current = resolvedChatId;
  const pendingSendErrorRef = useRef<Error | undefined>(undefined);

  const chat = useChat<PageWiseUIMessage>({
    id: resolvedChatId,
    transport: transportRef.current,
    onError: (error) => {
      pendingSendErrorRef.current = error;
      if (import.meta.env.DEV) {
        console.error("[PageWise agent]", error);
      }
    },
    onData: (part) => {
      if (isAgentProgressDataPart(part)) {
        setStreamProgress(part.data.message || null);
      }
    },
    onFinish: ({ message, isAbort, isError }) => {
      if (streamAgentGenRef.current !== agentGenRef.current) return;

      setStreamProgress(null);
      if (!isError) pendingSendErrorRef.current = undefined;

      const meta = getPageWiseMetadata(message);
      if (!isAbort && meta?.finishedAt == null) {
        setMessagesRef.current?.((prev) =>
          prev.map((m) => {
            if (m.id !== message.id) return m;
            const existing = getPageWiseMetadata(m) ?? {};
            return {
              ...m,
              metadata: { ...existing, finishedAt: Date.now() },
            };
          }),
        );
      } else if (isAbort) {
        setMessagesRef.current?.((prev) => {
          const next = prev
            .filter((m) => !(m.id === message.id && m.parts.length === 0))
            .map((m) => {
              if (m.id !== message.id) return m;
              const existing = getPageWiseMetadata(m) ?? {};
              if (existing.finishedAt != null) return m;
              return {
                ...m,
                metadata: { ...existing, finishedAt: Date.now() },
              };
            });
          return next;
        });
      }

      if (isAbort || message.role !== "assistant") return;
    },
  });
  setMessagesRef.current = chat.setMessages;
  messagesRef.current = chat.messages;

  const prevStatusRef = useRef(chat.status);
  const sendingRef = useRef(false);
  const [sendPhase, setSendPhase] = useState(false);
  const sendGenRef = useRef(0);
  const pendingSendContextRef = useRef<AgentMessageContext | null>(null);
  const lastSendOptionsRef = useRef<{ includeViewingPage: boolean } | null>(null);
  const isAgentBusyRef = useRef<() => boolean>(() => false);
  const [historySettling, setHistorySettling] = useState(false);

  const abortPendingSend = useCallback(() => {
    if (!sendingRef.current) return;
    sendGenRef.current += 1;
    sendingRef.current = false;
    setSendPhase(false);
    pendingSendContextRef.current = null;
    rollbackLastAgentMessage();
  }, []);

  isAgentBusyRef.current = () =>
    sendPhase ||
    sendingRef.current ||
    chat.status === "streaming" ||
    chat.status === "submitted";

  useEffect(() => {
    agentGenRef.current += 1;
    sendGenRef.current += 1;
    sendingRef.current = false;
    setSendPhase(false);
    setHistorySettling(false);
    pendingSendContextRef.current = null;
    clearAgentRunAbortSignal();
    chat.stop();
  }, [resolvedChatId, chat.stop]);

  useEffect(() => {
    const wasBusy =
      prevStatusRef.current === "streaming" || prevStatusRef.current === "submitted";
    prevStatusRef.current = chat.status;

    if (wasBusy && (chat.status === "ready" || chat.status === "error")) {
      setStreamProgress(null);
    }

    if (wasBusy && (chat.status === "ready" || chat.status === "error")) {
      setHistorySettling(true);
      const pruneForChatId = resolvedChatId;
      if (pruneTimeoutRef.current != null) {
        window.clearTimeout(pruneTimeoutRef.current);
      }
      pruneTimeoutRef.current = window.setTimeout(() => {
        pruneTimeoutRef.current = null;
        if (pruneChatIdRef.current !== pruneForChatId) {
          setHistorySettling(false);
          return;
        }
        chat.setMessages((prev) => pruneToolOutputsForHistory(prev) as typeof prev);
        if (pruneInnerTimeoutRef.current != null) {
          window.clearTimeout(pruneInnerTimeoutRef.current);
        }
        pruneInnerTimeoutRef.current = window.setTimeout(() => {
          pruneInnerTimeoutRef.current = null;
          setHistorySettling(false);
        }, 300);
      }, 0);
      return () => {
        if (pruneTimeoutRef.current != null) {
          window.clearTimeout(pruneTimeoutRef.current);
          pruneTimeoutRef.current = null;
        }
        if (pruneInnerTimeoutRef.current != null) {
          window.clearTimeout(pruneInnerTimeoutRef.current);
          pruneInnerTimeoutRef.current = null;
        }
        setHistorySettling(false);
      };
    }
  }, [chat.status, chat.setMessages, resolvedChatId]);

  const [sendError, setSendError] = useState<Error | undefined>();

  const readSendError = useCallback(
    () => pendingSendErrorRef.current ?? chat.error,
    [chat.error],
  );

  const clearSendError = useCallback(() => {
    pendingSendErrorRef.current = undefined;
    chat.clearError();
  }, [chat.clearError]);

  const prepareForAgentSend = useCallback(async (): Promise<boolean> => {
    const sendGen = sendGenRef.current;
    const agentGen = agentGenRef.current;
    const chatIdAtStart = resolvedChatId;
    const settings = await loadSettings();
    if (
      sendGen !== sendGenRef.current ||
      agentGen !== agentGenRef.current ||
      chatIdAtStart !== resolvedChatId
    ) {
      return false;
    }
    // Only block a send on hard errors (missing model id / base URL). The
    // tool-capability check is a heuristic guess — don't pre-block the agent on
    // it; let the model try and surface the real provider error. Settings still
    // shows the capability warning via validateAgentModel.
    const modelError = validateModel(settings, t);
    if (modelError) {
      setSendError(new Error(modelError));
      return false;
    }
    try {
      assertApiKeyForAgent(settings, t);
    } catch (e) {
      setSendError(e instanceof Error ? e : new Error(String(e)));
      return false;
    }
    clearSendError();
    setSendError(undefined);
    if (
      sendGen !== sendGenRef.current ||
      agentGen !== agentGenRef.current ||
      chatIdAtStart !== resolvedChatId
    ) {
      return false;
    }
    chat.setMessages(
      (prev) =>
        sanitizeMessagesForChat(
          stripUserFileParts(
            sanitizeDanglingToolParts(pruneToolOutputsForHistory(prev)),
            settings.provider,
          ),
        ) as typeof prev,
    );
    return true;
  }, [clearSendError, chat.setMessages, resolvedChatId, t]);

  const buildSendPayload = useCallback(
    async (opts: SendDocumentMessageOptions, text: string) => {
      if (opts.includeViewingPage) {
        const settings = await loadSettings();
        if (isAgentMultimodalModel(settings.provider, settings.model)) {
          const file = await capturePageFilePart(opts.path, opts.viewingPage, opts.docKind);
          if (file) {
            return { text, files: [file] };
          }
        }
      }
      return { text };
    },
    [],
  );

  const rollbackOptimisticUser = useCallback(
    (messageId: string | undefined, fallbackText: string) => {
      chat.setMessages((prev) => {
        if (messageId) {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx >= 0 && prev[idx]?.role === "user") {
            return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
          }
        }
        const last = prev[prev.length - 1];
        if (last?.role !== "user") return prev;
        if (extractUserText(last) !== fallbackText.trim()) return prev;
        return prev.slice(0, -1);
      });
    },
    [chat.setMessages],
  );

  const runAgentSend = useCallback(
    async (
      opts: SendDocumentMessageOptions,
      text: string,
      messageId: string | undefined,
      sendGen: number,
    ): Promise<boolean> => {
      const ctx: AgentMessageContext = {
        path: opts.path,
        docName: opts.docName,
        viewingPage: opts.viewingPage,
        totalPages: opts.totalPages,
        userText: text,
        includeViewingPage: opts.includeViewingPage,
      };
      pendingSendContextRef.current = ctx;
      beginAgentMessage(ctx);
      lastSendOptionsRef.current = { includeViewingPage: opts.includeViewingPage };
      streamAgentGenRef.current = agentGenRef.current;

      try {
        if (sendGen !== sendGenRef.current || streamAgentGenRef.current !== agentGenRef.current) {
          rollbackLastAgentMessage();
          return false;
        }
        const payload = await buildSendPayload({ ...opts, text }, text);
        if (
          sendGen !== sendGenRef.current ||
          streamAgentGenRef.current !== agentGenRef.current
        ) {
          rollbackLastAgentMessage();
          return false;
        }
        await sendWithImageFallback(
          { ...payload, messageId },
          (p) => chat.sendMessage(p),
          readSendError,
          clearSendError,
          () => rollbackOptimisticUser(messageId, text),
          () => {
            rollbackLastAgentMessage();
            if (pendingSendContextRef.current) {
              beginAgentMessage(pendingSendContextRef.current);
            }
          },
        );
        return sendGen === sendGenRef.current;
      } catch (e) {
        rollbackLastAgentMessage();
        const err = e instanceof Error ? e : new Error(String(e));
        setSendError(err);
        return false;
      }
    },
    [
      buildSendPayload,
      chat.sendMessage,
      readSendError,
      clearSendError,
      rollbackOptimisticUser,
    ],
  );

  const sendDocumentMessage = useCallback(
    async (opts: SendDocumentMessageOptions): Promise<boolean> => {
      if (isAgentBusyRef.current()) return false;

      const sendGen = sendGenRef.current;
      sendingRef.current = true;
      setSendPhase(true);
      try {
        if (!(await prepareForAgentSend())) return false;
        if (sendGen !== sendGenRef.current) return false;
        return await runAgentSend(opts, opts.text, undefined, sendGen);
      } finally {
        if (sendGen === sendGenRef.current) {
          sendingRef.current = false;
          setSendPhase(false);
          pendingSendContextRef.current = null;
        }
      }
    },
    [chat.status, prepareForAgentSend, runAgentSend],
  );

  const editUserMessage = useCallback(
    async (messageId: string, opts: SendDocumentMessageOptions): Promise<boolean> => {
      if (isAgentBusyRef.current()) return false;

      const sendGen = sendGenRef.current;
      sendingRef.current = true;
      setSendPhase(true);
      try {
        if (!(await prepareForAgentSend())) return false;
        if (sendGen !== sendGenRef.current) return false;
        return await runAgentSend(opts, opts.text, messageId, sendGen);
      } finally {
        if (sendGen === sendGenRef.current) {
          sendingRef.current = false;
          setSendPhase(false);
          pendingSendContextRef.current = null;
        }
      }
    },
    [chat.status, prepareForAgentSend, runAgentSend],
  );

  const regenerateDocumentMessage = useCallback(
    async (opts: RegenerateDocumentMessageOptions): Promise<boolean> => {
      if (isAgentBusyRef.current()) return false;

      const lastUser = findLastMessage(messagesRef.current, (m) => m.role === "user");
      if (!lastUser) return false;
      const text = extractUserText(lastUser);
      if (!text.trim()) return false;

      const includeViewingPage =
        lastSendOptionsRef.current?.includeViewingPage ?? opts.includeViewingPage;
      const sendOpts: SendDocumentMessageOptions = { ...opts, text, includeViewingPage };

      const sendGen = sendGenRef.current;
      sendingRef.current = true;
      setSendPhase(true);
      try {
        if (!(await prepareForAgentSend())) return false;
        if (sendGen !== sendGenRef.current) return false;

        chat.setMessages((prev) => {
          let lastUserIdx = -1;
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i]?.role === "user") {
              lastUserIdx = i;
              break;
            }
          }
          if (lastUserIdx < 0) return prev;
          const trimmed = prev.slice(0, lastUserIdx + 1);
          return trimmed.length === prev.length ? prev : trimmed;
        });

        pendingSendErrorRef.current = undefined;
        clearSendError();
        return await runAgentSend(sendOpts, text, lastUser.id, sendGen);
      } finally {
        if (sendGen === sendGenRef.current) {
          sendingRef.current = false;
          setSendPhase(false);
          pendingSendContextRef.current = null;
        }
      }
    },
    [chat.status, prepareForAgentSend, runAgentSend, clearSendError, chat.setMessages],
  );

  const clearChat = useCallback(() => {
    chat.stop();
    clearAgentRunAbortSignal();
    chat.setMessages([]);
    chat.clearError();
    setSendError(undefined);
    setStreamProgress(null);
  }, [chat.stop, chat.setMessages, chat.clearError]);

  const activeError = chat.error ?? sendError;
  const errorMessage = useMemo(
    () => (activeError ? formatAgentError(activeError, t) : undefined),
    [activeError, t],
  );

  const waitForStreamIdleFn = useCallback(async (): Promise<boolean> => {
    return waitForStreamIdle({
      isBusy: () => isAgentBusyRef.current(),
      stop: () => chat.stop(),
      abortPendingSend,
      forceReset: () => {
        agentGenRef.current += 1;
        chat.stop();
        clearAgentRunAbortSignal();
        sendingRef.current = false;
        setSendPhase(false);
        setStreamProgress(null);
      },
    });
  }, [chat.stop, abortPendingSend]);

  return useMemo(
    () => ({
      messages: chat.messages,
      sendDocumentMessage,
      editUserMessage,
      regenerateDocumentMessage,
      streamProgress,
      status: chat.status,
      error: activeError,
      errorMessage,
      stop: chat.stop,
      setMessages: chat.setMessages,
      clearError: chat.clearError,
      clearChat,
      historySettling,
      chatId: resolvedChatId,
      resetForDocumentSwitch: () => {
        agentGenRef.current += 1;
        abortPendingSend();
        sendGenRef.current += 1;
        if (pruneTimeoutRef.current != null) {
          window.clearTimeout(pruneTimeoutRef.current);
          pruneTimeoutRef.current = null;
        }
        chat.stop();
        clearAgentRunAbortSignal();
        chat.clearError();
        setSendError(undefined);
        setStreamProgress(null);
      },
      isAgentBusy: () => isAgentBusyRef.current(),
      abortPendingSend,
      waitForStreamIdle: waitForStreamIdleFn,
    }),
    [
      chat.messages,
      chat.status,
      activeError,
      errorMessage,
      chat.stop,
      chat.setMessages,
      chat.clearError,
      clearChat,
      sendDocumentMessage,
      editUserMessage,
      regenerateDocumentMessage,
      streamProgress,
      historySettling,
      resolvedChatId,
      abortPendingSend,
      waitForStreamIdleFn,
      sendPhase,
    ],
  );
}
