import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { beginAgentMessage, rollbackLastAgentMessage } from "../lib/agent-view-context";
import { createDocAgent } from "../lib/agent";
import { isAgentProgressDataPart } from "../lib/inject-progress-stream";
import { formatAgentError, validateAgentModel, assertApiKeyForAgent } from "../lib/llm";
import {
  extractAssistantText,
  extractToolExcerpts,
  extractUserText,
  findLastMessage,
} from "../lib/messages-utils";
import { getPageWiseMetadata, type PageWiseUIMessage } from "../lib/message-metadata";
import { PagewiseChatTransport } from "../lib/pagewise-chat-transport";
import {
  pruneToolOutputsForHistory,
  sanitizeDanglingToolParts,
} from "../lib/prune-chat-history";
import { extractStructuredCitations } from "../lib/structured-citations";
import { loadSettings } from "../lib/settings";
import { useI18n } from "../i18n";

export interface SendDocumentMessageOptions {
  text: string;
  path: string;
  docName: string;
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

export function useDocAgent() {
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

  const chat = useChat<PageWiseUIMessage>({
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

      void extractStructuredCitations(answer, excerpts).then((citations) => {
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
      });
    },
  });
  setMessagesRef.current = chat.setMessages;

  const prevStatusRef = useRef(chat.status);
  const sendingRef = useRef(false);

  useEffect(() => {
    const wasBusy =
      prevStatusRef.current === "streaming" || prevStatusRef.current === "submitted";
    prevStatusRef.current = chat.status;

    if (wasBusy && chat.status === "ready") {
      setStreamProgress(null);
      const id = window.setTimeout(() => {
        chat.setMessages((prev) => pruneToolOutputsForHistory(prev) as typeof prev);
      }, 0);
      return () => window.clearTimeout(id);
    }
  }, [chat.status, chat.setMessages]);

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
          await chat.sendMessage({ text: opts.text });
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
    [chat.sendMessage, chat.status, prepareForAgentSend],
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
      regenerateDocumentMessage,
      streamProgress,
      status: chat.status,
      error: activeError,
      errorMessage,
      stop: chat.stop,
      setMessages: chat.setMessages,
      clearError: chat.clearError,
      clearChat,
      resetForDocumentSwitch: () => {
        chat.stop();
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
      regenerateDocumentMessage,
      streamProgress,
    ],
  );
}
