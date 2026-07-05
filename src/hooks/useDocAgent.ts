import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { beginAgentMessage, rollbackLastAgentMessage } from "../lib/agent-view-context";
import { createDocAgent } from "../lib/agent";
import { isAgentProgressDataPart } from "../lib/inject-progress-stream";
import { formatAgentError, validateAgentModel, assertApiKeyForAgent } from "../lib/llm";
import { isAgentMultimodalModel } from "../lib/model-capabilities";
import {
  extractAssistantText,
  extractToolExcerpts,
  extractUserText,
  findLastMessage,
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
) {
  return new PagewiseChatTransport({
    agent,
    onError,
    resolveModelLabel: async () => {
      const settings = await loadSettings();
      return settings.model?.trim() || settings.provider;
    },
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
    transportRef.current = createTransport(agentRef.current, (error) =>
      formatErrorRef.current(error),
    );
  }

  const setMessagesRef = useRef<
    ReturnType<typeof useChat<PageWiseUIMessage>>["setMessages"] | null
  >(null);

  const [streamProgress, setStreamProgress] = useState<string | null>(null);
  const resolvedChatId = chatId ?? "pagewise-local";
  const pruneChatIdRef = useRef(resolvedChatId);
  const pruneTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  pruneChatIdRef.current = resolvedChatId;

  const chat = useChat<PageWiseUIMessage>({
    id: resolvedChatId,
    transport: transportRef.current,
    onError: (error) => {
      if (import.meta.env.DEV) {
        console.error("[PageWise agent]", error);
      }
    },
    onData: (part) => {
      if (isAgentProgressDataPart(part)) {
        setStreamProgress(part.data.message || null);
      }
    },
    onFinish: ({ message, isAbort }) => {
      setStreamProgress(null);

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
        setMessagesRef.current?.((prev) =>
          prev.map((m) => {
            if (m.id !== message.id) return m;
            const existing = getPageWiseMetadata(m) ?? {};
            if (existing.finishedAt != null) return m;
            return {
              ...m,
              metadata: { ...existing, finishedAt: Date.now() },
            };
          }),
        );
      }

      if (isAbort || message.role !== "assistant") return;

      const answer = extractAssistantText(message);
      const excerpts = extractToolExcerpts(message);
      if (!answer) return;

      const citationGen = citationGenRef.current;
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

  const prevStatusRef = useRef(chat.status);
  const sendingRef = useRef(false);
  const [historySettling, setHistorySettling] = useState(false);
  const lastTotalPagesRef = useRef<number | undefined>(undefined);
  const citationGenRef = useRef(0);

  useEffect(() => {
    citationGenRef.current += 1;
  }, [resolvedChatId]);

  useEffect(() => {
    const wasBusy =
      prevStatusRef.current === "streaming" || prevStatusRef.current === "submitted";
    prevStatusRef.current = chat.status;

    if (wasBusy && (chat.status === "ready" || chat.status === "error")) {
      setStreamProgress(null);
      clearAgentRunAbortSignal();
    }

    if (wasBusy && chat.status === "ready") {
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
    chat.clearError();
    setSendError(undefined);
    chat.setMessages(
      (prev) =>
        sanitizeDanglingToolParts(pruneToolOutputsForHistory(prev)) as typeof prev,
    );
    return true;
  }, [chat.clearError, chat.setMessages, t]);

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

  const sendDocumentMessage = useCallback(
    async (opts: SendDocumentMessageOptions): Promise<boolean> => {
      if (
        sendingRef.current ||
        chat.status === "streaming" ||
        chat.status === "submitted"
      ) {
        return false;
      }

      sendingRef.current = true;
      lastTotalPagesRef.current = opts.totalPages;
      try {
        if (!(await prepareForAgentSend())) return false;

        beginAgentMessage({
          path: opts.path,
          docName: opts.docName,
          viewingPage: opts.viewingPage,
          totalPages: opts.totalPages,
          userText: opts.text,
          includeViewingPage: opts.includeViewingPage,
        });

        try {
          const payload = await buildSendPayload(opts, opts.text);
          await chat.sendMessage(payload);
          return true;
        } catch (e) {
          rollbackLastAgentMessage();
          const err = e instanceof Error ? e : new Error(String(e));
          setSendError(err);
          return false;
        }
      } finally {
        sendingRef.current = false;
      }
    },
    [chat.sendMessage, chat.status, prepareForAgentSend, buildSendPayload],
  );

  const editUserMessage = useCallback(
    async (messageId: string, opts: SendDocumentMessageOptions): Promise<boolean> => {
      if (
        sendingRef.current ||
        chat.status === "streaming" ||
        chat.status === "submitted"
      ) {
        return false;
      }

      sendingRef.current = true;
      lastTotalPagesRef.current = opts.totalPages;
      try {
        if (!(await prepareForAgentSend())) return false;

        beginAgentMessage({
          path: opts.path,
          docName: opts.docName,
          viewingPage: opts.viewingPage,
          totalPages: opts.totalPages,
          userText: opts.text,
          includeViewingPage: opts.includeViewingPage,
        });

        try {
          const payload = await buildSendPayload(opts, opts.text);
          await chat.sendMessage({ ...payload, messageId });
          return true;
        } catch (e) {
          rollbackLastAgentMessage();
          const err = e instanceof Error ? e : new Error(String(e));
          setSendError(err);
          return false;
        }
      } finally {
        sendingRef.current = false;
      }
    },
    [chat.sendMessage, chat.status, prepareForAgentSend, buildSendPayload],
  );

  const regenerateDocumentMessage = useCallback(
    async (opts: RegenerateDocumentMessageOptions): Promise<boolean> => {
      if (
        sendingRef.current ||
        chat.status === "streaming" ||
        chat.status === "submitted"
      ) {
        return false;
      }

      const lastUser = findLastMessage(chat.messages, (m) => m.role === "user");
      if (!lastUser) return false;
      const text = extractUserText(lastUser);
      if (!text.trim()) return false;

      sendingRef.current = true;
      lastTotalPagesRef.current = opts.totalPages;
      try {
        if (!(await prepareForAgentSend())) return false;

        beginAgentMessage({
          path: opts.path,
          docName: opts.docName,
          viewingPage: opts.viewingPage,
          totalPages: opts.totalPages,
          userText: text,
          includeViewingPage: opts.includeViewingPage,
        });

        try {
          await chat.regenerate();
          return true;
        } catch (e) {
          rollbackLastAgentMessage();
          const err = e instanceof Error ? e : new Error(String(e));
          setSendError(err);
          return false;
        }
      } finally {
        sendingRef.current = false;
      }
    },
    [chat.messages, chat.regenerate, chat.status, prepareForAgentSend],
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
    ],
  );
}
