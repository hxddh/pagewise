import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DirectChatTransport } from "ai";
import { beginAgentMessage } from "../lib/agent-view-context";
import { createDocAgent } from "../lib/agent";
import { formatAgentError, validateAgentModel } from "../lib/llm";
import { loadSettings } from "../lib/settings";
import { pruneToolOutputsForHistory } from "../lib/prune-chat-history";
import { useI18n } from "../i18n";

export interface SendDocumentMessageOptions {
  text: string;
  path: string;
  docName: string;
  viewingPage: number;
  totalPages: number;
  includeViewingPage: boolean;
}

export function useDocAgent() {
  const { t } = useI18n();
  const agentRef = useRef(createDocAgent());
  const formatErrorRef = useRef<(error: unknown) => string>((error) =>
    formatAgentError(error),
  );
  formatErrorRef.current = (error) => formatAgentError(error, t);

  const transportRef = useRef(
    new DirectChatTransport({
      agent: agentRef.current,
      onError: (error) => formatErrorRef.current(error),
    }),
  );

  const chat = useChat({
    transport: transportRef.current,
    experimental_throttle: 50,
    onError: (error) => {
      if (import.meta.env.DEV) {
        console.error("[PageWise agent]", error);
      }
    },
  });

  const prevStatusRef = useRef(chat.status);

  useEffect(() => {
    const wasBusy =
      prevStatusRef.current === "streaming" || prevStatusRef.current === "submitted";
    prevStatusRef.current = chat.status;

    if (wasBusy && chat.status === "ready") {
      chat.setMessages((prev) => pruneToolOutputsForHistory(prev) as typeof prev);
    }
  }, [chat.status, chat.setMessages]);

  const [sendError, setSendError] = useState<Error | undefined>();

  const sendDocumentMessage = useCallback(
    async (opts: SendDocumentMessageOptions) => {
      chat.clearError();
      setSendError(undefined);
      chat.setMessages((prev) => pruneToolOutputsForHistory(prev) as typeof prev);

      const settings = await loadSettings();
      const modelError = validateAgentModel(settings, t);
      if (modelError) {
        setSendError(new Error(modelError));
        return;
      }

      beginAgentMessage({
        path: opts.path,
        docName: opts.docName,
        viewingPage: opts.viewingPage,
        totalPages: opts.totalPages,
        userText: opts.text,
        includeViewingPage: opts.includeViewingPage,
      });
      await chat.sendMessage({ text: opts.text });
    },
    [chat.sendMessage, chat.setMessages, chat.clearError, t],
  );

  const clearChat = useCallback(() => {
    chat.stop();
    chat.setMessages([]);
    chat.clearError();
    setSendError(undefined);
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
    ],
  );
}
