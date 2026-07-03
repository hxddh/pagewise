import { useCallback, useEffect, useState } from "react";
import { getToolName, isToolUIPart } from "ai";
import { open } from "@tauri-apps/plugin-dialog";
import { ChatPanel } from "./pages/ChatPanel";
import { DocumentPreview } from "./components/DocumentPreview";
import { DropOverlay } from "./components/DropOverlay";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { ContextBar } from "./components/ContextBar";
import { ResizeHandle } from "./components/ResizeHandle";
import { AgentRail } from "./components/AgentRail";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { ToastViewport } from "./components/ToastViewport";
import { RecentFilesList } from "./components/RecentFilesList";
import { ChatSessionsList } from "./components/ChatSessionsList";
import { CommandPalette } from "./components/CommandPalette";
import { useDocAgent } from "./hooks/useDocAgent";
import { useTauriFileDrop } from "./hooks/useTauriFileDrop";
import { useResizeWidth } from "./hooks/useResizeWidth";
import { useDocumentLoader } from "./hooks/useDocumentLoader";
import { useChatPersistence } from "./hooks/useChatPersistence";
import { useTheme } from "./hooks/useTheme";
import { useAppCommands } from "./hooks/useAppCommands";
import { ToastProvider, useToast } from "./hooks/useToast";
import { clearPdfCache } from "./lib/pdf";
import { isSupportedDocument } from "./lib/load-document";
import { getLatestAgentActivity } from "./lib/citations";
import { loadSettings } from "./lib/settings";
import { loadPreferences, applyTheme, resolveTheme } from "./lib/preferences";
import { getRecentFiles, removeRecentFile, type RecentFile } from "./lib/recent-files";
import type { LoadedDocument, LlmSettings } from "./lib/types";
import "./App.css";

function isApiKeyConfigured(settings: LlmSettings): boolean {
  if (settings.provider === "ollama") return true;
  return settings.apiKey.trim().length > 0;
}

function AppShell() {
  const [activeDoc, setActiveDoc] = useState<LoadedDocument | null>(null);
  const [previewPage, setPreviewPage] = useState(1);
  const [followAgent, setFollowAgent] = useState(true);
  const [fileError, setFileError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentCollapsed, setAgentCollapsed] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const { showToast } = useToast();
  const { cycleTheme, reloadPreferences } = useTheme();
  const { width: chatWidth, onPointerDown } = useResizeWidth();
  const { messages, sendMessage, status, error, stop, setMessages } = useDocAgent();

  const handleDocumentLoaded = useCallback((doc: LoadedDocument) => {
    clearPdfCache();
    setActiveDoc(doc);
    setPreviewPage(1);
    setFileError(null);
    setAgentCollapsed(false);
  }, []);

  const { openPath, loading, progress } = useDocumentLoader({
    onLoaded: handleDocumentLoaded,
    onRecentChange: setRecentFiles,
    onError: (message) => setFileError(message || null),
  });

  const { sessions, deleteSession } = useChatPersistence({
    docPath: activeDoc?.path ?? null,
    docName: activeDoc?.name ?? null,
    messages,
    setMessages: setMessages as (messages: import("ai").UIMessage[]) => void,
  });

  const refreshApiKeyStatus = useCallback(() => {
    loadSettings().then((s) => setHasApiKey(isApiKeyConfigured(s)));
  }, []);

  const onPreferencesSaved = useCallback(async () => {
    await reloadPreferences();
    const prefs = await loadPreferences();
    applyTheme(resolveTheme(prefs.theme));
  }, [reloadPreferences]);

  useEffect(() => {
    refreshApiKeyStatus();
    getRecentFiles().then(setRecentFiles);
  }, [refreshApiKeyStatus]);

  const openFileFromSidebar = useCallback(async () => {
    setPickerOpen(true);
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: "Documents",
          extensions: ["pdf", "png", "jpg", "jpeg", "webp", "tiff", "bmp", "gif"],
        },
      ],
    });
    setPickerOpen(false);
    if (!selected || typeof selected !== "string") return;
    await openPath(selected);
  }, [openPath]);

  const busy = status === "streaming" || status === "submitted";
  const activity = getLatestAgentActivity(messages);

  const { commands, paletteOpen, setPaletteOpen, exportChat, exportSummary } = useAppCommands({
    activeDocName: activeDoc?.name ?? null,
    messages,
    busy,
    agentCollapsed,
    followAgent,
    previewPage,
    totalPages: activeDoc?.totalPages ?? 1,
    onOpenDocument: openFileFromSidebar,
    onOpenSettings: () => setSettingsOpen(true),
    onToggleAgent: () => setAgentCollapsed((c) => !c),
    onToggleFollowAgent: () => setFollowAgent((f) => !f),
    onClearChat: () => setMessages([]),
    onStop: stop,
    onPrevPage: () => setPreviewPage((p) => Math.max(1, p - 1)),
    onNextPage: () =>
      setPreviewPage((p) =>
        activeDoc?.kind === "pdf" ? Math.min(activeDoc.totalPages, p + 1) : p,
      ),
    onCycleTheme: cycleTheme,
    showToast,
  });

  const handleFileDrop = useCallback(
    async (paths: string[]) => {
      const path = paths.find(isSupportedDocument);
      if (!path) {
        setFileError("Unsupported file type. Use PDF or image files.");
        return;
      }
      await openPath(path);
    },
    [openPath],
  );

  const { isDragging } = useTauriFileDrop(handleFileDrop);

  const handlePageFocus = useCallback((page: number) => {
    setPreviewPage(page);
  }, []);

  useEffect(() => {
    if (!followAgent) return;

    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) return;

    for (const part of lastAssistant.parts) {
      if (!isToolUIPart(part) || part.state !== "output-available") continue;
      const name = getToolName(part);
      const input = part.input as { page?: number; start?: number } | undefined;
      if (name === "read_pdf_page" && input?.page) {
        setPreviewPage(input.page);
        break;
      }
      if (name === "read_pdf_range" && input?.start) {
        setPreviewPage(input.start);
        break;
      }
    }
  }, [messages, followAgent]);

  const openSessionDoc = useCallback(
    async (path: string) => {
      if (activeDoc?.path === path) return;
      await openPath(path);
    },
    [activeDoc?.path, openPath],
  );

  return (
    <div className="app">
      <DropOverlay visible={isDragging || (loading && !progress)} />
      <LoadingOverlay visible={loading} progress={progress} />
      <ToastViewport />
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => {
          refreshApiKeyStatus();
          void onPreferencesSaved();
        }}
      />

      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand">
            <h1>PageWise</h1>
          </div>
          <div className="sidebar-actions">
            <button
              type="button"
              className="btn ghost icon-btn"
              onClick={() => setPaletteOpen(true)}
              title="Commands (⌘K)"
              aria-label="Command palette"
            >
              ⌘K
            </button>
            <button
              type="button"
              className="btn icon-btn"
              onClick={() => setSettingsOpen(true)}
              title="Settings (⌘,)"
              aria-label="Settings"
            >
              ⚙
            </button>
          </div>
        </div>

        {!hasApiKey && (
          <button
            type="button"
            className="api-banner"
            onClick={() => setSettingsOpen(true)}
          >
            Configure API key to start
          </button>
        )}

        <button
          type="button"
          className="btn primary open-btn"
          onClick={openFileFromSidebar}
          disabled={loading || pickerOpen}
        >
          {loading || pickerOpen ? "Opening…" : "Open document"}
        </button>

        <RecentFilesList
          files={recentFiles}
          activePath={activeDoc?.path ?? null}
          onOpen={openPath}
          onRemove={async (path) => setRecentFiles(await removeRecentFile(path))}
        />

        <ChatSessionsList
          sessions={sessions}
          activePath={activeDoc?.path ?? null}
          onOpen={openSessionDoc}
          onClear={deleteSession}
        />

        {activeDoc && (
          <div className="sidebar-doc">
            <h3>Current</h3>
            <p className="doc-name">{activeDoc.name}</p>
            <p className="doc-meta">
              {activeDoc.kind === "pdf"
                ? `${activeDoc.totalPages} pages · p. ${previewPage}`
                : "Image"}
            </p>
          </div>
        )}

        <p className="sidebar-hint">⌘K commands · ⌘F search</p>
      </aside>

      <div className="workspace">
        <DocumentPreview
          doc={activeDoc}
          page={previewPage}
          onPageChange={setPreviewPage}
        />

        {agentCollapsed ? (
          <AgentRail onExpand={() => setAgentCollapsed(false)} hasActivity={busy} />
        ) : (
          <>
            <ResizeHandle onPointerDown={onPointerDown} />
            <div className="chat-column" style={{ width: chatWidth }}>
              {fileError && <p className="error-line workspace-error">{fileError}</p>}
              <ContextBar
                doc={activeDoc}
                previewPage={previewPage}
                followAgent={followAgent}
                onFollowAgentChange={setFollowAgent}
                activity={busy ? activity : null}
              />
              <ChatPanel
                activeDoc={activeDoc}
                messages={messages}
                sendMessage={sendMessage}
                status={status}
                error={error}
                hasApiKey={hasApiKey}
                loadingDoc={loading}
                onOpenPath={openPath}
                onPageFocus={handlePageFocus}
                onFileError={setFileError}
                onOpenSettings={() => setSettingsOpen(true)}
                onStop={stop}
                onClearChat={() => setMessages([])}
                onCollapse={() => setAgentCollapsed(true)}
                onExportChat={exportChat}
                onExportSummary={exportSummary}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function App() {
  return (
    <ToastProvider>
      <AppShell />
    </ToastProvider>
  );
}

export default App;
