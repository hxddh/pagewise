import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatPanelHandle } from "../pages/ChatPanel";
import { useDocAgent } from "./useDocAgent";
import { useResizeWidth } from "./useResizeWidth";
import { useConnectionStatus } from "./useConnectionStatus";
import { useI18n } from "../i18n";
import { getAgentActivity } from "../lib/citations";
import { formatAgentActivityLine } from "../lib/agent-activity-line";

export function useAgentWorkspace(chatId: string | null = null) {
  const { t } = useI18n();
  const chatPanelRef = useRef<ChatPanelHandle>(null);
  const [agentOpen, setAgentOpen] = useState(
    () => localStorage.getItem("pagewise.agentOpen") !== "0",
  );
  const [composerDraft, setComposerDraft] = useState("");

  const { canUseAgent, hasApiKey, agentToolsSupported, settingsReady, refresh: refreshConnection } =
    useConnectionStatus();
  const {
    width: chatWidth,
    onPointerDown,
    nudgeWidth,
    min: minWidth,
    max: maxWidth,
  } = useResizeWidth();
  const {
    messages,
    sendDocumentMessage,
    regenerateDocumentMessage,
    editUserMessage,
    streamProgress,
    status,
    error,
    errorMessage,
    stop,
    setMessages,
    clearChat,
    resetForDocumentSwitch,
    historySettling,
  } = useDocAgent(chatId);

  useEffect(() => {
    localStorage.setItem("pagewise.agentOpen", agentOpen ? "1" : "0");
  }, [agentOpen]);

  const busy = status === "streaming" || status === "submitted";
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [busy]);

  const activity = useMemo(() => {
    const raw =
      streamProgress?.trim() ? streamProgress : getAgentActivity(messages, busy, t);
    return formatAgentActivityLine({
      messages,
      busy,
      activity: raw,
      nowMs,
      t,
    });
  }, [streamProgress, busy, messages, t, nowMs]);

  const focusComposer = useCallback(() => {
    chatPanelRef.current?.focusComposer();
  }, []);

  return useMemo(
    () => ({
      chatPanelRef,
      agentOpen,
      setAgentOpen,
      composerDraft,
      setComposerDraft,
      canUseAgent,
      hasApiKey,
      agentToolsSupported,
      settingsReady,
      refreshConnection,
      chatWidth,
      onPointerDown,
      nudgeWidth,
      minWidth,
      maxWidth,
      messages,
      sendDocumentMessage,
      editUserMessage,
      regenerateDocumentMessage,
      status,
      error,
      errorMessage,
      stop,
      setMessages,
      clearChat,
      resetForDocumentSwitch,
      busy,
      activity,
      historySettling,
      focusComposer,
    }),
    [
      agentOpen,
      composerDraft,
      canUseAgent,
      hasApiKey,
      agentToolsSupported,
      settingsReady,
      refreshConnection,
      chatWidth,
      onPointerDown,
      nudgeWidth,
      minWidth,
      maxWidth,
      messages,
      sendDocumentMessage,
      editUserMessage,
      regenerateDocumentMessage,
      status,
      error,
      errorMessage,
      stop,
      setMessages,
      clearChat,
      resetForDocumentSwitch,
      busy,
      activity,
      historySettling,
      focusComposer,
    ],
  );
}
