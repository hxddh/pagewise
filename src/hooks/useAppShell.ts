import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTheme } from "./useTheme";
import { useAppCommands } from "./useAppCommands";
import { useToast } from "./useToast";
import { useI18n } from "../i18n";
import { applyTheme, loadPreferences, resolveTheme, type SettingsTab } from "../lib/preferences";
import { getRecentFiles, removeRecentFiles, type RecentFile } from "../lib/recent-files";
import { restoreAllowedPaths } from "../lib/allowed-paths";
import { clearAgentMessageContext } from "../lib/agent-view-context";
import { useDocumentWorkspace } from "./useDocumentWorkspace";
import { useLibraryState } from "./useLibraryState";
import { useAgentWorkspace } from "./useAgentWorkspace";
import type { ShellContextValue } from "../contexts/ShellContext";

export function useAppShell() {
  const { t, refreshFromPreferences } = useI18n();
  const { showToast } = useToast();
  const { cycleTheme, reloadPreferences } = useTheme();

  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [threadSessionId, setThreadSessionId] = useState("default");
  const prepareOpenRef = useRef<() => void>(() => {});
  const document = useDocumentWorkspace(
    setRecentFiles,
    showToast,
    t,
    () => prepareOpenRef.current(),
  );

  const chatId = useMemo(
    () =>
      document.activeDoc?.path
        ? `${document.activeDoc.path}::${threadSessionId}`
        : "pagewise-local",
    [document.activeDoc?.path, threadSessionId],
  );

  const agent = useAgentWorkspace(chatId);

  const agentRef = useRef(agent);
  agentRef.current = agent;

  prepareOpenRef.current = () => {
    agentRef.current.resetForDocumentSwitch();
    agentRef.current.setComposerDraft("");
    clearAgentMessageContext();
  };

  const handleDocumentSwitch = useCallback((_nextPath: string | null) => {
    agentRef.current.resetForDocumentSwitch();
    agentRef.current.setComposerDraft("");
    clearAgentMessageContext();
  }, []);

  const handleThreadSwitch = useCallback(() => {
    agentRef.current.setComposerDraft("");
  }, []);

  const documentCommitRef = useRef(document.commitDocumentSwitch);
  documentCommitRef.current = document.commitDocumentSwitch;
  const documentAbortRef = useRef(document.abortDocumentSwitch);
  documentAbortRef.current = document.abortDocumentSwitch;

  const handleDocumentSwitchCommitted = useCallback(() => {
    documentCommitRef.current();
  }, []);

  const handleDocumentSwitchFailed = useCallback(() => {
    documentAbortRef.current();
  }, []);

  const handlePersistError = useCallback(
    (messageKey: string) => {
      showToast(t(messageKey), "error");
    },
    [showToast, t],
  );

  const library = useLibraryState({
    activeDoc: document.activeDoc,
    docLoadSeq: document.docLoadSeq,
    messages: agent.messages,
    setMessages: agent.setMessages as (messages: import("ai").UIMessage[]) => void,
    openPath: document.openPath,
    recentFiles,
    setRecentFiles,
    onDocumentSwitch: handleDocumentSwitch,
    onDocumentSwitchCommitted: handleDocumentSwitchCommitted,
    onDocumentSwitchFailed: handleDocumentSwitchFailed,
    onThreadSwitch: handleThreadSwitch,
    onStopStream: agent.stop,
    isStreaming: agent.busy,
    isAgentBusy: agent.isAgentBusy,
    onAbortPendingSend: agent.abortPendingSend,
    onResetAgent: agent.resetForDocumentSwitch,
    onPersistError: handlePersistError,
    onActiveSessionIdChange: (id) => {
      flushSync(() => setThreadSessionId(id));
    },
  });

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>();
  const [prefsRevision, setPrefsRevision] = useState(0);
  const [indexRevision, setIndexRevision] = useState(0);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const recents = await getRecentFiles();
        const { failed } = await restoreAllowedPaths(recents.map((f) => f.path));
        if (failed.length > 0) {
          const updated = await removeRecentFiles(failed);
          setRecentFiles(updated);
          showToast(t("toast.pathRestoreFailed", { count: failed.length }), "error");
        } else {
          setRecentFiles(recents);
        }
      } catch {
        showToast(t("toast.pathRestoreFailed", { count: 1 }), "error");
      }
    })();
  }, [showToast, t]);

  const focusComposerRef = useRef(agent.focusComposer);
  focusComposerRef.current = agent.focusComposer;

  const reindexRef = useRef(document.reindexActiveDoc);
  reindexRef.current = document.reindexActiveDoc;

  useEffect(() => {
    document.onLoadedRef.current = () => {
      window.setTimeout(() => focusComposerRef.current(), 100);
    };
  }, [document.onLoadedRef]);

  useEffect(() => {
    document.syncPageFromAgent(agent.messages, agent.busy);
  }, [agent.messages, agent.busy, document.followAgent, document.syncPageFromAgent]);

  const handleLlmSettingsSaved = useCallback(() => {
    agentRef.current.refreshConnection();
  }, []);

  const handleReindexDoc = useCallback(() => {
    setIndexRevision((r) => r + 1);
    if (document.activeDoc) {
      reindexRef.current();
    }
  }, [document.activeDoc]);

  const onPreferencesSaved = useCallback(async () => {
    await reloadPreferences();
    await refreshFromPreferences();
    const prefs = await loadPreferences();
    applyTheme(resolveTheme(prefs.theme));
    setPrefsRevision((r) => r + 1);
    document.setFollowAgent(prefs.followAgentDefault);
    document.setIncludeViewingPage(prefs.includeViewingPageDefault);
  }, [reloadPreferences, refreshFromPreferences, document]);

  const handleApiReady = useCallback(() => {
    showToast(t("toast.aiReady"), "success");
    agentRef.current.focusComposer();
  }, [showToast, t]);

  const openSettings = useCallback((tab?: SettingsTab) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);

  const toggleAgent = useCallback(() => {
    agentRef.current.setAgentOpen((open) => {
      if (open) {
        if (localStorage.getItem("pagewise.collapseHintShown") !== "1") {
          showToast(t("toast.collapseHint"), "default");
          localStorage.setItem("pagewise.collapseHintShown", "1");
        }
        return false;
      }
      window.setTimeout(() => agentRef.current.focusComposer(), 80);
      return true;
    });
  }, [showToast, t]);

  const expandAgent = useCallback(() => {
    agentRef.current.setAgentOpen(true);
    window.setTimeout(() => agentRef.current.focusComposer(), 80);
  }, []);

  const requestClearChat = useCallback(() => {
    if (agent.messages.length === 0 && !agent.error) return;
    setClearConfirmOpen(true);
  }, [agent.messages.length, agent.error]);

  const clearChat = useCallback(() => {
    agentRef.current.stop();
    agentRef.current.abortPendingSend();
    agentRef.current.clearError();
    agentRef.current.setComposerDraft("");
    void library.clearCurrentThread();
    setClearConfirmOpen(false);
  }, [library.clearCurrentThread]);

  const { commands, paletteOpen, setPaletteOpen, exportChat, exportSummary } = useAppCommands({
    activeDocName: document.activeDoc?.name ?? null,
    messages: agent.messages,
    busy: agent.busy,
    followAgent: document.followAgent,
    agentOpen: agent.agentOpen,
    previewPage: document.previewPage,
    totalPages: document.activeDoc?.totalPages ?? 1,
    onOpenDocument: document.openFileDialog,
    onOpenSettings: () => openSettings(),
    onToggleFollowAgent: () => document.setFollowAgent((f) => !f),
    onToggleAgent: toggleAgent,
    onClearChat: requestClearChat,
    onStop: agent.stop,
    onCycleTheme: () => void cycleTheme(),
    showToast,
  });

  const shell = useMemo<ShellContextValue>(
    () => ({
      settingsOpen,
      settingsTab,
      setSettingsOpen,
      setSettingsTab,
      openSettings,
      paletteOpen,
      setPaletteOpen,
      commands,
      prefsRevision,
      indexRevision,
      showToast,
      onPreferencesSaved,
      handleApiReady,
      handleLlmSettingsSaved,
      handleReindexDoc,
      exportChat,
      exportSummary,
      toggleAgent,
      expandAgent,
      clearChat,
      requestClearChat,
      clearConfirmOpen,
      setClearConfirmOpen,
    }),
    [
      settingsOpen,
      settingsTab,
      setSettingsOpen,
      setSettingsTab,
      openSettings,
      paletteOpen,
      setPaletteOpen,
      commands,
      prefsRevision,
      indexRevision,
      showToast,
      onPreferencesSaved,
      handleApiReady,
      handleLlmSettingsSaved,
      handleReindexDoc,
      exportChat,
      exportSummary,
      toggleAgent,
      expandAgent,
      clearChat,
      requestClearChat,
      clearConfirmOpen,
      setClearConfirmOpen,
    ],
  );

  return { document, library, agent, shell };
}
