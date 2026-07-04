import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DirectChatTransport } from "ai";
import { beginAgentMessage } from "../lib/agent-view-context";
import { createDocAgent } from "../lib/agent";
import { formatAgentError, validateAgentModel } from "../lib/llm";
import { loadSettings } from "../lib/settings";
import {
  pruneToolOutputsForHistory,
  sanitizeDanglingToolParts,
} from "../lib/prune-chat-history";
import { useI18n } from "../i18n";

export interface SendDocumentMessageOptions {
  text: string;
  path: string;
  docName: string;
  viewingPage: number;
  totalPages: number;
  includeViewingPage: boolean;
}

function createTransport(
  agent: ReturnType<typeof createDocAgent>,
  onError: (error: unknown) => string,
) {
  return new DirectChatTransport({ agent, onError });
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

  const chat = useChat({
    transport: transportRef.current,
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

    // Defer prune until after the final assistant message is flushed — avoids
    // racing status=ready against the last streamed text update.
    if (wasBusy && chat.status === "ready") {
      const id = window.setTimeout(() => {
        chat.setMessages((prev) => pruneToolOutputsForHistory(prev) as typeof prev);
      }, 0);
      return () => window.clearTimeout(id);
    }
  }, [chat.status, chat.setMessages]);

  const [sendError, setSendError] = useState<Error | undefined>();

  const sendDocumentMessage = useCallback(
    async (opts: SendDocumentMessageOptions): Promise<boolean> => {
      chat.clearError();
      setSendError(undefined);
      chat.setMessages(
        (prev) =>
          sanitizeDanglingToolParts(pruneToolOutputsForHistory(prev)) as typeof prev,
      );

      const settings = await loadSettings();
      const modelError = validateAgentModel(settings, t);
      if (modelError) {
        setSendError(new Error(modelError));
        return false;
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
      return true;
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
