import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { beginAgentMessage, rollbackLastAgentMessage, type AgentMessageContext } from "../lib/agent-view-context";
import { sendWithImageFallback } from "../lib/agent-send";
import { createDocAgent } from "../lib/agent";
import { isAgentProgressDataPart } from "../lib/inject-progress-stream";
import { formatAgentError, validateAgentModel, assertApiKeyForAgent } from "../lib/llm";
import { isAgentMultimodalModel } from "../lib/model-capabilities";
import {
  extractAssistantText,
  extractToolExcerpts,
  extractUserText,
  findLastMessage,
  sanitizeMessagesForChat,
  stripUserFileParts,
} from "../lib/messages-utils";
import { getPageWiseMetadata, type PageWiseUIMessage } from "../lib/message-metadata";
import { PagewiseChatTransport } from "../lib/pagewise-chat-transport";
import { clearAgentRunAbortSignal } from "../lib/vision-index";
import { capturePageFilePart } from "../lib/pdf";
import {
  pruneToolOutputsForHistory,
  sanitizeDanglingToolParts,
} from "../lib/prune-chat-history";
import { streamStructuredCitations } from "../lib/structured-citations";
import { loadSettings } from "../lib/settings";
import type { LlmSettings } from "../lib/types";
import { useI18n } from "../i18n";

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
  if (transportRef.current === null) {
    transportRef.current = createTransport(
      agentRef.current,
      (error) => formatErrorRef.current(error),
      (repaired) => setMessagesRef.current?.(repaired),
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

      const answer = extractAssistantText(message);
      const excerpts = extractToolExcerpts(message);
      if (!answer) return;

      const citationGen = citationGenRef.current;
      abortCitationStream();
      const citationController = new AbortController();
      citationAbortRef.current = citationController;
      const citationSettings = runSettingsRef.current ?? undefined;
      void streamStructuredCitations(
        answer,
        excerpts,
        lastTotalPagesRef.current,
        (citations) => {
          if (citationGen !== citationGenRef.current) return;
          if (citations.length === 0) return;
          setMessagesRef.current?.((prev) =>
            prev.map((m) => {
              if (m.id !== message.id) return m;
              const existing = getPageWiseMetadata(m) ?? {};
              return {
                ...m,
                metadata: { ...existing, structuredCitations: citations },
              };
            }),
          );
        },
        { settings: citationSettings, abortSignal: citationController.signal },
      ).then((result) => {
        if (citationGen !== citationGenRef.current) return;
        if (!result.error) return;
        setMessagesRef.current?.((prev) =>
          prev.map((m) => {
            if (m.id !== message.id) return m;
            const existing = getPageWiseMetadata(m) ?? {};
            return {
              ...m,
              metadata: { ...existing, citationsError: result.error },
            };
          }),
        );
      });
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
  const lastTotalPagesRef = useRef<number | undefined>(undefined);
  const citationGenRef = useRef(0);
  const citationAbortRef = useRef<AbortController | null>(null);
  const runSettingsRef = useRef<LlmSettings | null>(null);

  const abortCitationStream = useCallback(() => {
    citationAbortRef.current?.abort();
    citationAbortRef.current = null;
  }, []);

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
    sendGenRef.current += 1;
    sendingRef.current = false;
    setSendPhase(false);
    pendingSendContextRef.current = null;
    abortCitationStream();
    citationGenRef.current += 1;
    chat.stop();
  }, [resolvedChatId, abortCitationStream, chat.stop]);

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
        if (pruneChatIdRef.current !== pruneForChatId) return;
        chat.setMessages((prev) => pruneToolOutputsForHistory(prev) as typeof prev);
        window.setTimeout(() => setHistorySettling(false), 300);
      }, 0);
      return () => {
        if (pruneTimeoutRef.current != null) {
          window.clearTimeout(pruneTimeoutRef.current);
          pruneTimeoutRef.current = null;
        }
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
    const settings = await loadSettings();
    const modelError = validateAgentModel(settings, t);
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
    runSettingsRef.current = settings;
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
  }, [clearSendError, chat.setMessages, t]);

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

      try {
        if (sendGen !== sendGenRef.current) return false;
        const payload = await buildSendPayload({ ...opts, text }, text);
        if (sendGen !== sendGenRef.current) {
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
      lastTotalPagesRef.current = opts.totalPages;
      abortCitationStream();
      citationGenRef.current += 1;
      try {
        if (!(await prepareForAgentSend())) return false;
        if (sendGen !== sendGenRef.current) return false;
        return await runAgentSend(opts, opts.text, undefined, sendGen);
      } finally {
        sendingRef.current = false;
        setSendPhase(false);
        pendingSendContextRef.current = null;
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
      lastTotalPagesRef.current = opts.totalPages;
      abortCitationStream();
      citationGenRef.current += 1;
      try {
        if (!(await prepareForAgentSend())) return false;
        if (sendGen !== sendGenRef.current) return false;
        return await runAgentSend(opts, opts.text, messageId, sendGen);
      } finally {
        sendingRef.current = false;
        setSendPhase(false);
        pendingSendContextRef.current = null;
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
      lastTotalPagesRef.current = opts.totalPages;
      abortCitationStream();
      citationGenRef.current += 1;
      try {
        if (!(await prepareForAgentSend())) return false;
        if (sendGen !== sendGenRef.current) return false;
        pendingSendErrorRef.current = undefined;
        clearSendError();
        return await runAgentSend(sendOpts, text, lastUser.id, sendGen);
      } finally {
        sendingRef.current = false;
        setSendPhase(false);
        pendingSendContextRef.current = null;
      }
    },
    [chat.status, prepareForAgentSend, runAgentSend, clearSendError],
  );

  const clearChat = useCallback(() => {
    chat.stop();
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
        abortPendingSend();
        sendGenRef.current += 1;
        abortCitationStream();
        citationGenRef.current += 1;
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
      abortCitationStream,
      sendPhase,
    ],
  );
}
