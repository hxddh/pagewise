import { ToastProvider } from "./hooks/useToast";
import { useAppShell } from "./hooks/useAppShell";
import { useI18n } from "./i18n";
import { ShellProvider } from "./contexts/ShellContext";
import { ChatPanel } from "./pages/ChatPanel";
import { PreviewPane } from "./features/preview/PreviewPane";
import { DropOverlay } from "./components/DropOverlay";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { ResizeHandle } from "./components/ResizeHandle";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { ToastViewport } from "./components/ToastViewport";
import { CommandPalette } from "./components/CommandPalette";
import { AppRail } from "./components/AppRail";
import { LibraryDrawer } from "./components/LibraryDrawer";
import { WelcomeView } from "./components/WelcomeView";
import { AgentDock } from "./components/AgentDock";
import { FileErrorBanner } from "./components/FileErrorBanner";
import { ConfirmBar } from "./components/ConfirmBar";
import { removeRecentFile } from "./lib/recent-files";
import "./styles/tokens.css";
import "./styles/preview.css";
import "./styles/settings.css";
import "./App.css";
import "./AppV3.css";

function AppShell() {
  const { document, library, agent, shell } = useAppShell();
  const { t } = useI18n();

  return (
    <ShellProvider value={shell}>
      <div className="app v3">
        <DropOverlay visible={document.isDragging} />
        <LoadingOverlay
          visible={document.loading}
          progress={
            document.progress ?? { stage: "opening" as const, message: "load.opening", percent: 0 }
          }
        />
        {document.fileError && (
          <FileErrorBanner message={document.fileError} onDismiss={document.clearFileError} />
        )}
        <ToastViewport />

        {shell.clearConfirmOpen && (
          <div className="global-confirm">
            <ConfirmBar
              message={t("agent.clearConfirm")}
              confirmLabel={t("agent.clear")}
              danger
              onConfirm={shell.clearChat}
              onCancel={() => shell.setClearConfirmOpen(false)}
            />
          </div>
        )}

        <CommandPalette
          open={shell.paletteOpen}
          commands={shell.commands}
          onClose={() => shell.setPaletteOpen(false)}
        />

        <SettingsDrawer
          open={shell.settingsOpen}
          initialTab={shell.settingsTab}
          onClose={() => {
            shell.setSettingsOpen(false);
            shell.setSettingsTab(undefined);
          }}
          onLlmSettingsSaved={shell.handleLlmSettingsSaved}
          onReindexDoc={shell.handleReindexDoc}
          onApiReady={shell.handleApiReady}
          onPreferencesSaved={shell.onPreferencesSaved}
          followAgentDefault={document.followAgent}
          onFollowAgentDefaultChange={document.setFollowAgent}
          includeViewingPageDefault={document.includeViewingPage}
          onIncludeViewingPageDefaultChange={document.setIncludeViewingPage}
          onTestResult={(message, ok) => shell.showToast(message, ok ? "success" : "error")}
          onSaveError={() => shell.showToast(t("settings.saveFailed"), "error")}
        />

        <AppRail
          libraryOpen={library.libraryOpen}
          onLibrary={() => library.setLibraryOpen((o) => !o)}
          onOpenFile={document.openFileDialog}
          onSettings={() => shell.openSettings()}
          connected={agent.canUseAgent}
          opening={document.loading || document.pickerOpen}
        />

        <LibraryDrawer
          open={library.libraryOpen}
          onClose={() => library.setLibraryOpen(false)}
          recentFiles={library.recentFiles}
          sessions={library.sessions}
          activePath={document.activeDoc?.path ?? null}
          onOpenRecent={document.openPath}
          onRemoveRecent={async (path) =>
            library.setRecentFiles(await removeRecentFile(path))
          }
          onOpenSession={library.openSessionFromLibrary}
          onClearSession={library.deleteSession}
          onOpenFile={document.openFileDialog}
        />

        <div className="v3-main">
          {!document.activeDoc ? (
            <WelcomeView
              recentFiles={library.recentFiles}
              canUseAgent={agent.canUseAgent}
              hasApiKey={agent.hasApiKey}
              agentToolsSupported={agent.agentToolsSupported}
              opening={document.loading || document.pickerOpen}
              onOpenFile={document.openFileDialog}
              onOpenRecent={document.openPath}
              onConfigureApi={() => shell.openSettings("ai")}
            />
          ) : (
            <div className={`v3-workspace ${agent.agentOpen ? "" : "agent-hidden"}`}>
              <PreviewPane
                doc={document.activeDoc}
                page={document.previewPage}
                onPageChange={document.setPreviewPage}
                prefsRevision={shell.prefsRevision}
                onOpenAiSettings={() => shell.openSettings("ai")}
              />

              {agent.agentOpen && (
                <ResizeHandle
                  onPointerDown={agent.onPointerDown}
                  onNudge={agent.nudgeWidth}
                  value={agent.chatWidth}
                  min={agent.minWidth}
                  max={agent.maxWidth}
                />
              )}
              <div
                className={`chat-column ${agent.agentOpen ? "" : "chat-column-hidden"}`}
                style={agent.agentOpen ? { width: agent.chatWidth } : undefined}
                aria-hidden={!agent.agentOpen}
              >
                <ChatPanel
                  ref={agent.chatPanelRef}
                  activeDoc={document.activeDoc}
                  previewPage={document.previewPage}
                  includeViewingPage={document.includeViewingPage}
                  messages={agent.messages}
                  sendDocumentMessage={agent.sendDocumentMessage}
                  status={agent.status}
                  error={agent.error}
                  errorMessage={agent.errorMessage}
                  hasApiKey={agent.hasApiKey}
                  agentToolsSupported={agent.agentToolsSupported}
                  settingsReady={agent.settingsReady}
                  loadingDoc={document.loading}
                  chatLoading={library.chatLoading}
                  activity={agent.busy ? agent.activity : null}
                  composerDraft={agent.composerDraft}
                  onComposerDraftChange={agent.setComposerDraft}
                  onConfigureApi={() => shell.openSettings("ai")}
                  onStop={agent.stop}
                  onClearChat={shell.requestClearChat}
                  onExportChat={shell.exportChat}
                  onExportSummary={shell.exportSummary}
                  onCollapse={() => shell.toggleAgent()}
                />
              </div>

              {!agent.agentOpen && (
                <AgentDock
                  onExpand={shell.expandAgent}
                  busy={agent.busy}
                  messageCount={agent.messages.length}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </ShellProvider>
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
