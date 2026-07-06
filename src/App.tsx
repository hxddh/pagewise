import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { ToastProvider, useToast } from "./hooks/useToast";
import { SessionProvider, useSession } from "./session/SessionProvider";
import { useI18n } from "./i18n";
import { DropOverlay } from "./components/DropOverlay";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { ResizeHandle } from "./components/ResizeHandle";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { ToastViewport } from "./components/ToastViewport";
import { AppRail } from "./components/AppRail";
import { WelcomeView } from "./components/WelcomeView";
import { AgentDock } from "./components/AgentDock";
import { FileErrorBanner } from "./components/FileErrorBanner";
import { ConfirmBar } from "./components/ConfirmBar";
import { RecentFilesDrawer } from "./components/RecentFilesDrawer";
import { CommandPalette } from "./components/CommandPalette";
import { useAppCommands } from "./hooks/useAppCommands";
import { useFollowAgent } from "./hooks/useFollowAgent";
import { useTheme } from "./hooks/useTheme";
import { useWorkbenchPrefs } from "./hooks/useWorkbenchPrefs";
import "./styles/tokens.css";
import "./styles/preview.css";
import "./styles/settings.css";
import "./App.css";
import "./AppV3.css";

const PreviewPane = lazy(() =>
  import("./features/preview/PreviewPane").then((m) => ({ default: m.PreviewPane })),
);
const ChatPanel = lazy(() =>
  import("./pages/ChatPanel").then((m) => ({ default: m.ChatPanel })),
);

function PanelFallback() {
  const { t } = useI18n();
  return (
    <div className="panel-loading" aria-live="polite">
      <span className="preview-loading-spinner" aria-hidden />
      <span className="sr-only">{t("app.panelLoading")}</span>
    </div>
  );
}

function AppContent() {
  const { t } = useI18n();
  const { showToast } = useToast();
  const s = useSession();
  const { cycleTheme } = useTheme();
  const prefs = useWorkbenchPrefs();

  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [composerDraft, setComposerDraft] = useState("");

  const doc = s.document;
  const agent = s.agent;
  const conn = s.connection;
  const agentBusy = agent.isAgentBusy();

  useEffect(() => {
    setComposerDraft("");
  }, [doc?.path]);

  const requestClearChat = useCallback(() => setClearConfirmOpen(true), []);

  const { commands, paletteOpen, setPaletteOpen, exportSummary } = useAppCommands({
    activeDocName: doc?.name ?? null,
    messages: agent.messages,
    busy: agentBusy,
    followAgent: prefs.followAgent,
    agentOpen: s.agentOpen,
    previewPage: s.previewPage,
    totalPages: doc?.totalPages ?? 1,
    onOpenDocument: s.openFileDialog,
    onOpenSettings: () => s.setSettingsOpen(true),
    onToggleFollowAgent: () => void prefs.toggleFollowAgent(),
    onToggleAgent: () => s.setAgentOpen(!s.agentOpen),
    onClearChat: requestClearChat,
    onStop: agent.stop,
    onCycleTheme: () => void cycleTheme(),
    showToast,
  });

  useFollowAgent(prefs.followAgent, agent.messages, agentBusy, s.setPreviewPage);

  return (
    <div className="app v3">
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
      <DropOverlay visible={s.isDragging} />
      <LoadingOverlay
        visible={s.loading || s.phase === "switching"}
        progress={s.progress ?? { stage: "opening", message: "load.opening", percent: 0 }}
      />
      {s.fileError && (
        <FileErrorBanner message={s.fileError} onDismiss={s.clearFileError} />
      )}
      <ToastViewport />

      {clearConfirmOpen && (
        <div className="global-confirm">
          <ConfirmBar
            message={t("agent.clearConfirm")}
            confirmLabel={t("agent.clear")}
            danger
            onConfirm={() => {
              void s.clearChat();
              setClearConfirmOpen(false);
            }}
            onCancel={() => setClearConfirmOpen(false)}
          />
        </div>
      )}

      <RecentFilesDrawer
        open={libraryOpen}
        recentFiles={s.recentFiles}
        activePath={doc?.path ?? null}
        opening={s.loading}
        onClose={() => setLibraryOpen(false)}
        onOpenFile={() => {
          setLibraryOpen(false);
          s.openFileDialog();
        }}
        onOpenRecent={(path) => void s.openPath(path)}
        onRemoveRecent={(path) => void s.removeRecent(path)}
      />

      <SettingsDrawer
        open={s.settingsOpen}
        onClose={() => s.setSettingsOpen(false)}
        onLlmSettingsSaved={() => conn.refresh()}
        onApiReady={() => conn.refresh()}
        onReindexDoc={s.reindexDoc}
        onPreferencesSaved={async () => {
          await prefs.refreshPrefs();
        }}
        followAgentDefault={prefs.followAgent}
        onFollowAgentDefaultChange={(value) => void prefs.setFollowAgentDefault(value)}
        includeViewingPageDefault={prefs.includeViewingPage}
        onIncludeViewingPageDefaultChange={(value) => void prefs.setIncludeViewingPageDefault(value)}
        onTestResult={(message, ok) => showToast(message, ok ? "success" : "error")}
        onSaveError={() => showToast(t("settings.saveFailed"), "error")}
      />

      <AppRail
        showLibrary
        libraryOpen={libraryOpen}
        onLibrary={() => setLibraryOpen((o) => !o)}
        onOpenFile={s.openFileDialog}
        onSettings={() => s.setSettingsOpen(true)}
        connected={conn.canUseAgent && conn.settingsReady}
        opening={s.loading}
      />

      <div className="v3-main">
        {!doc ? (
          <WelcomeView
            recentFiles={s.recentFiles}
            canUseAgent={conn.canUseAgent}
            hasApiKey={conn.hasApiKey}
            agentToolsSupported={conn.agentToolsSupported}
            opening={s.loading}
            onOpenFile={s.openFileDialog}
            onOpenRecent={s.openPath}
            onConfigureApi={() => s.setSettingsOpen(true)}
          />
        ) : (
          <div className={`v3-workspace ${s.agentOpen ? "" : "agent-hidden"}`}>
            <Suspense fallback={<PanelFallback />}>
              <PreviewPane
                doc={doc}
                page={s.previewPage}
                onPageChange={s.setPreviewPage}
                prefsRevision={prefs.prefsRevision}
                onOpenAiSettings={() => s.setSettingsOpen(true)}
              />
            </Suspense>

            {s.agentOpen && (
              <ResizeHandle
                onPointerDown={s.onPointerDown}
                onNudge={s.nudgeWidth}
                value={s.chatWidth}
                min={s.minWidth}
                max={s.maxWidth}
              />
            )}
            <div
              className={`chat-column ${s.agentOpen ? "" : "chat-column-hidden"}`}
              style={s.agentOpen ? { width: s.chatWidth } : undefined}
              aria-hidden={!s.agentOpen}
            >
              <Suspense fallback={<PanelFallback />}>
                <ChatPanel
                  activeDoc={doc}
                  previewPage={s.previewPage}
                  includeViewingPage={prefs.includeViewingPage}
                  messages={agent.messages}
                  sendDocumentMessage={agent.sendDocumentMessage}
                  editUserMessage={agent.editUserMessage}
                  regenerateDocumentMessage={agent.regenerateDocumentMessage}
                  status={agent.status}
                  error={agent.error}
                  errorMessage={agent.errorMessage}
                  hasApiKey={conn.hasApiKey}
                  agentToolsSupported={conn.agentToolsSupported}
                  settingsReady={conn.settingsReady}
                  loadingDoc={s.loading}
                  chatLoading={s.chatLoading}
                  agentBusy={agentBusy}
                  activity={agentBusy ? agent.streamProgress : null}
                  historySettling={agent.historySettling}
                  composerDraft={composerDraft}
                  onComposerDraftChange={setComposerDraft}
                  onConfigureApi={() => s.setSettingsOpen(true)}
                  onStop={agent.stop}
                  onClearChat={requestClearChat}
                  onExportChat={() => void s.exportChat()}
                  onExportSummary={() => void exportSummary()}
                  onCollapse={() => s.setAgentOpen(false)}
                />
              </Suspense>
            </div>

            {!s.agentOpen && (
              <AgentDock
                onExpand={() => s.setAgentOpen(true)}
                busy={agentBusy}
                messageCount={agent.messages.length}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function App() {
  return (
    <ToastProvider>
      <SessionProvider>
        <AppContent />
      </SessionProvider>
    </ToastProvider>
  );
}

export default App;
