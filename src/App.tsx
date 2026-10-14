import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ToastProvider, useToast } from "./hooks/useToast";
import { SessionProvider, useSession } from "./session/SessionProvider";
import { useI18n } from "./i18n";
import { DropOverlay } from "./components/DropOverlay";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { ResizeHandle } from "./components/ResizeHandle";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { ToastViewport } from "./components/ToastViewport";
import { Button } from "./components/ui/Button";
import { AppRail } from "./components/AppRail";
import { WelcomeView } from "./components/WelcomeView";
import { AgentDock } from "./components/AgentDock";
import { FileErrorBanner } from "./components/FileErrorBanner";
import { RecentFilesDrawer } from "./components/RecentFilesDrawer";
import { ConfirmDialog } from "./components/overlays/ConfirmDialog";
import { indexWholeDocument, pendingIndexPages } from "./document/index-queue";
import { ocrEnabled } from "./lib/ocr/ocr-service";
import { getVisionCallCount } from "./lib/usage-tracker";
import { CommandPalette } from "./components/CommandPalette";
import { ExportDialog, type ExportAvailability, type ExportChoice } from "./components/ExportDialog";
import { activeFindings } from "./lib/finding-store";
import { useAppCommands } from "./hooks/useAppCommands";
import { useFollowAgent } from "./hooks/useFollowAgent";
import { useWorkbenchOverlays } from "./hooks/useWorkbenchOverlays";
import { useTheme } from "./hooks/useTheme";
import { useWorkbenchPrefs } from "./hooks/useWorkbenchPrefs";
import { openableRecentFiles } from "./lib/recent-files";
import { getMarks } from "./lib/mark-store";
import type { RevealedCitation } from "./features/preview/CitationHighlight";
import "./styles/tokens.css";
import "./styles/ui.css";
import "./styles/preview.css";
import "./styles/settings.css";
import "./styles/app/01-base.css";
import "./styles/app/02-shell-layout.css";
import "./styles/app/03-preview-pane.css";
import "./styles/app/04-chat.css";
import "./styles/app/05-chat-empty-composer.css";
import "./styles/app/06-drawer-overlay.css";
import "./styles/app/07-preview-chrome.css";
import "./styles/app/08-recents-toasts.css";
import "./styles/app/09-palette-status.css";
import "./styles/app/10-agent-activity.css";
import "./styles/app/11-pdf-layers.css";
import "./styles/app/12-shell-rail.css";
import "./styles/app/13-chat-late.css";
import "./styles/app/14-states.css";

const PreviewPane = lazy(() =>
  import("./features/preview/PreviewPane").then((m) => ({ default: m.PreviewPane })),
);
const ChatPanel = lazy(() =>
  import("./pages/ChatPanel").then((m) => ({ default: m.ChatPanel })),
);
// Type-only: the panel stays lazily loaded, but its imperative handle is what
// "Ask about this" uses to put the caret in the composer.
import type { ChatPanelHandle } from "./pages/ChatPanel";

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
  const overlays = useWorkbenchOverlays(s.setSettingsOpen);

  const [composerDraft, setComposerDraft] = useState("");
  /**
   * The recorded claim the reader asked to see.
   *
   * Lives here rather than in either column because it is the one piece of
   * state both of them need: the record panel picks it, the page draws it. The
   * page it was found on comes with it — a claim can cite several, and only one
   * of them carries the wording.
   */
  const [revealedFindingId, setRevealedFindingId] = useState<string | null>(null);
  // The citation the reader last followed from an answer. PreviewPane forgets
  // it once they leave its page; the nonce lets the same one be followed twice.
  const [revealedCitation, setRevealedCitation] = useState<RevealedCitation | null>(null);

  const doc = s.document;
  const agent = s.agent;
  const conn = s.connection;
  const agentBusy = agent.isAgentBusy();

  useEffect(() => {
    setComposerDraft("");
    setRevealedFindingId(null);
    setRevealedCitation(null);
    setZen(false);
  }, [doc?.path]);

  // Put something from the document into the composer and show it. The caller
  // decides what the text says — a quoted passage, or a sentence naming the
  // page a mark is on — because only the caller knows which it has.
  //
  // "Ask about this" has to end with the caret in the input (17.0): the reader
  // selected a passage in order to ask about it, and a click that leaves focus
  // on the page is a click that has to be followed by another one. The panel may
  // be closed at this instant, so the focus request is queued on a counter and
  // served after the panel has mounted.
  const chatRef = useRef<ChatPanelHandle>(null);
  const [focusComposerNonce, setFocusComposerNonce] = useState(0);
  /**
   * Zen (18.0): the rail, the toolbar and the panel leave; the page and a
   * progress hairline stay. Not persisted — it is a posture for this sitting,
   * not a preference, and a reader who wants it always has the shortcut.
   */
  const [zen, setZen] = useState(false);
  const askAboutSelection = useCallback(
    (text: string) => {
      const insert = text.trim();
      if (!insert) return;
      setComposerDraft((prev) => (prev.trim() ? `${prev.trim()} ${insert} ` : `${insert} `));
      s.setAgentOpen(true);
      setFocusComposerNonce((n) => n + 1);
    },
    [s],
  );

  useEffect(() => {
    if (focusComposerNonce === 0) return;
    // Two frames: one for the panel to mount, one for its textarea to exist.
    const id = requestAnimationFrame(() => requestAnimationFrame(() => chatRef.current?.focusComposer()));
    return () => cancelAnimationFrame(id);
  }, [focusComposerNonce]);

  const toggleZen = useCallback(() => setZen((z) => !z), []);
  /** The pill in Zen: leave it, show the panel, put the caret in the composer. */
  const askFromZen = useCallback(() => {
    setZen(false);
    s.setAgentOpen(true);
    setFocusComposerNonce((n) => n + 1);
  }, [s]);

  const openableRecents = openableRecentFiles(s.recentFiles);

  // Pages with no usable text yet — i.e. what a whole-document scan would send
  // to the vision model, and therefore bill for.
  const unscannedPages = useMemo(
    () => (doc ? pendingIndexPages(doc.path).length : 0),
    [doc?.path, doc?.pages],
  );
  const [scanAllPrompt, setScanAllPrompt] = useState<number | null>(null);
  // With local OCR on, "scan all" reads locally first and bills only the rest.
  const scanAllKey = ocrEnabled() ? "preview.scanAllConfirmLocal" : "preview.scanAllConfirm";

  const requestScanAll = useCallback(() => {
    if (!doc) return;
    const count = pendingIndexPages(doc.path).length;
    if (count === 0) {
      showToast(t("toast.scanAllNone"), "default");
      return;
    }
    setScanAllPrompt(count);
  }, [doc, showToast, t]);

  // One way out for everything the app writes (16.0). What can be written is
  // read when the dialog opens: findings and marks change without App knowing.
  const [exportAvailable, setExportAvailable] = useState<ExportAvailability | null>(null);
  const openExport = useCallback(() => {
    if (!doc) return;
    setExportAvailable({
      report: activeFindings(doc.path).length > 0 || getMarks(doc.path).length > 0,
      pdf: doc.kind === "pdf",
      chat: agent.messages.length > 0,
    });
  }, [doc, agent.messages.length]);
  const runExport = useCallback(
    (choice: ExportChoice, options: { includeText: boolean }) => {
      if (choice === "report") void s.exportReport(options);
      else if (choice === "pdf") void s.exportAnnotatedPdf();
      else void s.exportChat();
    },
    [s],
  );

  const { commands, paletteOpen, setPaletteOpen } = useAppCommands({
    activeDocName: doc?.name ?? null,
    messages: agent.messages,
    busy: agentBusy,
    followAgent: prefs.followAgent,
    agentOpen: s.agentOpen,
    previewPage: s.previewPage,
    totalPages: doc?.totalPages ?? 1,
    onOpenDocument: s.openFileDialog,
    onOpenSettings: overlays.openSettings,
    onToggleFollowAgent: () => void prefs.toggleFollowAgent(),
    onToggleAgent: () => s.setAgentOpen(!s.agentOpen),
    onToggleZen: toggleZen,
    onClearChat: overlays.openClearConfirm,
    onStop: agent.stop,
    onCycleTheme: () => void cycleTheme(),
    onOpenExport: openExport,
    onScanAllPages: requestScanAll,
    canScanAllPages: unscannedPages > 0,
  });

  useFollowAgent(prefs.followAgent, agent.messages, s.setPreviewPage);

  /**
   * True while the reader is dragging the divider.
   *
   * The panel's width transition is for opening and closing; during a drag the
   * width changes on every pointer move, and interpolating each of those makes
   * the divider trail the pointer.
   */
  const [panelDragging, setPanelDragging] = useState(false);
  useEffect(() => {
    if (!panelDragging) return;
    const end = () => setPanelDragging(false);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [panelDragging]);

  return (
    <div className={`app v3${zen && doc ? " zen" : ""}`}>
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
      <ExportDialog
        open={exportAvailable !== null}
        available={exportAvailable ?? { report: false, pdf: false, chat: false }}
        busy={agentBusy}
        onExport={runExport}
        onClose={() => setExportAvailable(null)}
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

      <ConfirmDialog
        open={overlays.clearConfirmOpen}
        danger
        message={t("agent.clearConfirm")}
        confirmLabel={t("agent.clear")}
        onConfirm={() => {
          void s.clearChat();
          overlays.closeClearConfirm();
        }}
        onCancel={overlays.closeClearConfirm}
      />

      <ConfirmDialog
        open={scanAllPrompt !== null}
        message={
          doc && getVisionCallCount(doc.path) > 0
            ? `${t(scanAllKey, { count: scanAllPrompt ?? 0 })} ${t(
                "preview.scanAllUsed",
                { used: getVisionCallCount(doc.path) },
              )}`
            : t(scanAllKey, { count: scanAllPrompt ?? 0 })
        }
        confirmLabel={t("preview.scanAllAction")}
        onConfirm={() => {
          if (doc) {
            const started = indexWholeDocument(doc.path);
            if (started > 0) showToast(t("toast.scanAllStarted", { count: started }), "default");
          }
          setScanAllPrompt(null);
        }}
        onCancel={() => setScanAllPrompt(null)}
      />

      <RecentFilesDrawer
        open={overlays.libraryOpen}
        recentFiles={openableRecents}
        activePath={doc?.path ?? null}
        opening={s.loading}
        onClose={overlays.closeLibrary}
        onOpenFile={() => {
          overlays.closeLibrary();
          s.openFileDialog();
        }}
        onOpenRecent={(path) => void s.openPath(path)}
        onRemoveRecent={(path) => void s.removeRecent(path)}
      />

      <SettingsDrawer
        open={s.settingsOpen}
        onClose={overlays.closeSettings}
        assistantConfigured={conn.hasApiKey}
        settingsReady={conn.settingsReady}
        onLlmSettingsSaved={() => conn.refresh()}
        onApiReady={() => conn.refresh()}
        onReindexDoc={s.reindexDoc}
        onPreferencesSaved={async () => {
          await prefs.refreshPrefs();
        }}
        includeViewingPageDefault={prefs.includeViewingPage}
        onIncludeViewingPageDefaultChange={(value) => void prefs.setIncludeViewingPageDefault(value)}
        onTestResult={(message, ok) => showToast(message, ok ? "success" : "error")}
        onSaveError={() => showToast(t("settings.saveFailed"), "error")}
        onRefreshConnection={() => conn.refresh()}
      />

      {zen && doc && (
        <>
          {/* Reading progress, not scroll position: what a reader wants from a
              margin is "how much of this is left". */}
          <div className="zen-progress" aria-hidden>
            <span
              className="zen-progress-fill"
              style={{ height: `${Math.round((s.previewPage / Math.max(1, doc.totalPages)) * 100)}%` }}
            />
          </div>
          <Button variant="ghost" size="sm" className="zen-exit" onClick={toggleZen}>
            {t("zen.exit")}
          </Button>
          <Button variant="secondary" size="lg" className="zen-ask" onClick={askFromZen}>
            {t("zen.ask")}
          </Button>
        </>
      )}

      <AppRail
        showLibrary
        libraryOpen={overlays.libraryOpen}
        onLibrary={overlays.toggleLibrary}
        onOpenFile={s.openFileDialog}
        onSettings={overlays.openSettings}
        connected={conn.canUseAgent && conn.settingsReady}
        opening={s.loading}
      />

      <div className="v3-main">
        {!doc ? (
          <WelcomeView
            recentFiles={openableRecents}
            canUseAgent={conn.canUseAgent}
            hasApiKey={conn.hasApiKey}
            agentToolsSupported={conn.agentToolsSupported}
            opening={s.loading}
            onOpenFile={s.openFileDialog}
            onOpenRecent={s.openPath}
            onConfigureApi={overlays.openSettings}
          />
        ) : (
          <div className={`v3-workspace ${s.agentOpen ? "" : "agent-hidden"}`}>
            <Suspense fallback={<PanelFallback />}>
              <PreviewPane
                doc={doc}
                page={s.previewPage}
                onPageChange={s.setPreviewPage}
                prefsRevision={prefs.prefsRevision}
                onOpenAiSettings={overlays.openSettings}
                onAskAboutSelection={askAboutSelection}
                selectedFindingId={revealedFindingId}
                onSelectFinding={setRevealedFindingId}
                revealedCitation={revealedCitation}
              />
            </Suspense>

            {s.agentOpen && (
              <ResizeHandle
                onPointerDown={(e) => {
                  setPanelDragging(true);
                  s.onPointerDown(e);
                }}
                onNudge={s.nudgeWidth}
                value={s.chatWidth}
                min={s.minWidth}
                max={s.maxWidth}
              />
            )}
            <div
              className={`chat-column ${s.agentOpen ? "" : "chat-column-hidden"}${
                panelDragging ? " chat-column-dragging" : ""
              }`}
              style={s.agentOpen ? { width: s.chatWidth } : undefined}
              aria-hidden={!s.agentOpen}
            >
              <Suspense fallback={<PanelFallback />}>
                <ChatPanel
                  ref={chatRef}
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
                  webSearchAvailable={conn.webSearchAvailable}
                  settingsReady={conn.settingsReady}
                  loadingDoc={s.loading}
                  chatLoading={s.chatLoading}
                  agentBusy={agentBusy}
                  activity={agentBusy ? agent.streamProgress : null}
                  historySettling={agent.historySettling}
                  composerDraft={composerDraft}
                  onComposerDraftChange={setComposerDraft}
                  onConfigureApi={overlays.openSettings}
                  onStop={agent.stop}
                  waitForStreamIdle={agent.waitForStreamIdle}
                  steerRun={agent.steerRun}
                  onDismissError={agent.clearError}
                  onJumpToPage={s.setPreviewPage}
                  onRevealFinding={(id, page) => {
                    s.setPreviewPage(page);
                    setRevealedFindingId(id);
                  }}
                  onRevealCitation={(page, rects) => {
                    s.setPreviewPage(page);
                    setRevealedCitation(rects ? { page, rects, nonce: Date.now() } : null);
                  }}
                  onClearChat={overlays.openClearConfirm}
                  onOpenExport={openExport}
                  onCollapse={() => s.setAgentOpen(false)}
                  unscannedPages={unscannedPages}
                  onScanAllPages={requestScanAll}
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
