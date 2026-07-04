import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatPanelHandle } from "../pages/ChatPanel";
import { useDocAgent } from "./useDocAgent";
import { useResizeWidth } from "./useResizeWidth";
import { useConnectionStatus } from "./useConnectionStatus";
import { useI18n } from "../i18n";
import { getLatestAgentActivity } from "../lib/citations";

export function useAgentWorkspace() {
  const { t } = useI18n();
  const chatPanelRef = useRef<ChatPanelHandle>(null);
  const [agentOpen, setAgentOpen] = useState(
    () => localStorage.getItem("pagewise.agentOpen") !== "0",
  );
  const [composerDraft, setComposerDraft] = useState("");

  const { canUseAgent, hasApiKey, agentToolsSupported, settingsReady, refresh: refreshConnection } =
    useConnectionStatus();
  const { width: chatWidth, onPointerDown } = useResizeWidth();
  const {
    messages,
    sendDocumentMessage,
    status,
    error,
    errorMessage,
    stop,
    setMessages,
    clearChat,
    resetForDocumentSwitch,
  } = useDocAgent();

  useEffect(() => {
    localStorage.setItem("pagewise.agentOpen", agentOpen ? "1" : "0");
  }, [agentOpen]);

  const busy = status === "streaming" || status === "submitted";
  const activity = busy ? getLatestAgentActivity(messages, t) : null;

  const focusComposer = useCallback(() => {
    chatPanelRef.current?.focusComposer();
  }, []);

  return {
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
    messages,
    sendDocumentMessage,
    status,
    error,
    errorMessage,
    stop,
    setMessages,
    clearChat,
    resetForDocumentSwitch,
    busy,
    activity,
    focusComposer,
  };
}
