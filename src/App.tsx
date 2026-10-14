import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ToastProvider, useToast } from "./hooks/useToast";
import { useWorkbench } from "./session/useWorkbench";
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
import { activeFindings, subscribeFindings } from "./lib/finding-store";
import { useAppCommands } from "./hooks/useAppCommands";
import { useFollowAgent } from "./hooks/useFollowAgent";
import { useWorkbenchOverlays } from "./hooks/useWorkbenchOverlays";
import { useTheme } from "./hooks/useTheme";
import { useWorkbenchPrefs } from "./hooks/useWorkbenchPrefs";
import { openableRecentFiles } from "./lib/recent-files";
import { getMarks, subscribeMarks } from "./lib/mark-store";
import { citationsByPage } from "./lib/page-citations";
import { SearchScopeProvider, focusMessageRow } from "./components/SearchScope";
import { WorkspaceChromeProvider } from "./components/WorkspaceHeader";
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
  const s = useWorkbench();
  const { cycleTheme } = useTheme();
  const prefs = useWorkbenchPrefs();
  const overlays = useWorkbenchOverlays(s.assistant.shell.setSettingsOpen);

  const [composerDraft, setComposerDraft] = useState("");
  /**
   * The recorded claim the reader asked to see: the one piece of state both
   * columns need — the record panel picks it, the page draws it. The page it
   * was found on comes with it (a claim can cite several).
   */
  const [revealedFindingId, setRevealedFindingId] = useState<string | null>(null);
  /**
   * The mark the reader picked — on the page, in the margin, or in the record.
   * It lives here since 19.0 because the record panel is in the other column:
   * a mark selected there has to reach the preview to open its note.
   */
  const [selectedMarkId, setSelectedMarkId] = useState<string | null>(null);
  // The citation the reader last followed from an answer. PreviewPane forgets
  // it once they leave its page; the nonce lets the same one be followed twice.
  const [revealedCitation, setRevealedCitation] = useState<RevealedCitation | null>(null);
  // Which half of the assistant column is showing, and how many entries the
  // record holds. Both live here since 19.0: the tabs are in the workspace
  // header, and the badge beside them is drawn from the same subscription.
  const [panelTab, setPanelTab] = useState<"chat" | "record">("chat");
  const [recordRevision, setRecordRevision] = useState(0);

  const doc = s.document.doc;
  const agent = s.assistant.agent;
  const conn = s.assistant.connection;
  const agentBusy = agent.run.isBusy();
  const loading = s.document.phase === "switching";

  useEffect(() => {
    setComposerDraft("");
    setRevealedFindingId(null);
    setSelectedMarkId(null);
    setRevealedCitation(null);
    setZen(false);
  }, [doc?.path]);

  useEffect(() => {
    setRecordRevision((n) => n + 1);
    // Both stores: the record shows the assistant's findings and the reader's
    // marks since 19.0, and a counter that only moved for half of it would
    // leave a deleted mark on screen.
    const bump = () => setRecordRevision((n) => n + 1);
    const unsubFindings = subscribeFindings(bump);
    const unsubMarks = subscribeMarks(bump);
    return () => {
      unsubFindings();
      unsubMarks();
    };
  }, [doc?.path]);

  const recordCount = useMemo(
    () => (doc ? (void recordRevision, activeFindings(doc.path).length) : 0),
    [doc, recordRevision],
  );

  /**
   * Put something from the document into the composer and show it.
   *
   * "Ask about this" has to end with the caret in the input (17.0): a click
   * that leaves focus on the page is a click that has to be followed by
   * another one. The panel may be closed at this instant, so the focus
   * request is queued on a counter and served after the panel has mounted.
   */
  const chatRef = useRef<ChatPanelHandle>(null);
  const [focusComposerNonce, setFocusComposerNonce] = useState(0);
  // Zen (18.0): the rail, the header and the panel leave; the page and a
  // progress hairline stay. Not persisted — a posture for this sitting.
  const [zen, setZen] = useState(false);
  const askAboutSelection = useCallback(
    (text: string) => {
      const insert = text.trim();
      if (!insert) return;
      setComposerDraft((prev) => (prev.trim() ? `${prev.trim()} ${insert} ` : `${insert} `));
      s.assistant.setOpen(true);
      setFocusComposerNonce((n) => n + 1);
    },
    [s.assistant.setOpen],
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
    s.assistant.setOpen(true);
    setFocusComposerNonce((n) => n + 1);
  }, [s.assistant.setOpen]);

  const openableRecents = openableRecentFiles(s.library.recentFiles);

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

  // One way out for everything the app writes (16.0): what can be written is
  // read when the dialog opens, since findings and marks change silently.
  const [exportAvailable, setExportAvailable] = useState<ExportAvailability | null>(null);
  const openExport = useCallback(() => {
    if (!doc) return;
    setExportAvailable({
      report: activeFindings(doc.path).length > 0 || getMarks(doc.path).length > 0,
      pdf: doc.kind === "pdf",
      chat: agent.messages.list.length > 0,
    });
  }, [doc, agent.messages.list.length]);
  const runExport = useCallback(
    (choice: ExportChoice, options: { includeText: boolean }) => {
      if (choice === "report") void s.assistant.exports.report(options);
      else if (choice === "pdf") void s.assistant.exports.annotatedPdf();
      else void s.assistant.exports.chat();
    },
    [s.assistant.exports],
  );

  const { commands, paletteOpen, setPaletteOpen } = useAppCommands({
    activeDocName: doc?.name ?? null,
    messages: agent.messages.list,
    busy: agentBusy,
    agentOpen: s.assistant.open,
    previewPage: s.document.page,
    totalPages: doc?.totalPages ?? 1,
    onOpenDocument: s.library.openFileDialog,
    onOpenSettings: overlays.openSettings,
    onToggleAgent: () => s.assistant.setOpen(!s.assistant.open),
    onToggleZen: toggleZen,
    onClearChat: overlays.openClearConfirm,
    onStop: agent.run.stop,
    onCycleTheme: () => void cycleTheme(),
    onOpenExport: openExport,
  });

  useFollowAgent(prefs.followAgent, agent.messages.list, s.document.setPage);

  // True while the reader is dragging the divider: the width transition is
  // for opening and closing, and interpolating every pointer move would make
  // the divider trail the pointer.
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

  // The one search's conversation half (⌘F): what to search, and how to bring
  // a hit in front of the reader.
  const gotoMessage = useCallback(
    (id: string) => {
      s.assistant.setOpen(true);
      // The row exists even while the panel is closed (the column is hidden,
      // not unmounted), so one frame is enough for its render.
      requestAnimationFrame(() => {
        if (!focusMessageRow(id)) requestAnimationFrame(() => focusMessageRow(id));
      });
    },
    [s.assistant.setOpen],
  );
  const searchScope = useMemo(
    () => ({ messages: agent.messages.list, gotoMessage }),
    [agent.messages.list, gotoMessage],
  );

  // Which answers cite which page, for the page margin's indigo dots (19.0).
  const citedPages = useMemo(() => citationsByPage(agent.messages.list), [agent.messages.list]);

  // The header's slot, and the chrome it draws (tabs + overflow actions).
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const workspaceChrome = useMemo(
    () => ({
      slot: headerSlot,
      panelTab,
      setPanelTab,
      recordCount,
      agentOpen: s.assistant.open,
      hasMessages: agent.messages.list.length > 0,
      busy: agentBusy || loading || s.document.chatLoading,
      canScanAll: unscannedPages > 0,
      onScanAll: requestScanAll,
      onOpenExport: openExport,
      onClearChat: overlays.openClearConfirm,
      onToggleAgent: () => s.assistant.setOpen(!s.assistant.open),
    }),
    [
      headerSlot,
      panelTab,
      recordCount,
      s.assistant.open,
      s.assistant.setOpen,
      agent.messages.list.length,
      agentBusy,
      loading,
      s.document.chatLoading,
      unscannedPages,
      requestScanAll,
      openExport,
      overlays.openClearConfirm,
    ],
  );

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
      <DropOverlay visible={s.document.dragging} />
      <LoadingOverlay
        visible={loading}
        progress={s.document.progress ?? { stage: "opening", message: "load.opening", percent: 0 }}
      />
      {s.document.fileError.message && (
        <FileErrorBanner
          message={s.document.fileError.message}
          onDismiss={s.document.fileError.clear}
        />
      )}
      <ToastViewport />

      <ConfirmDialog
        open={overlays.clearConfirmOpen}
        danger
        message={t("agent.clearConfirm")}
        confirmLabel={t("agent.clear")}
        onConfirm={() => {
          void s.assistant.clearChat();
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
        opening={loading}
        onClose={overlays.closeLibrary}
        onOpenFile={() => {
          overlays.closeLibrary();
          s.library.openFileDialog();
        }}
        onOpenRecent={(path) => void s.library.openPath(path)}
        onRemoveRecent={(path) => void s.library.removeRecent(path)}
      />

      <SettingsDrawer
        open={s.assistant.shell.settingsOpen}
        onClose={overlays.closeSettings}
        assistantConfigured={conn.hasApiKey}
        settingsReady={conn.settingsReady}
        onLlmSettingsSaved={() => conn.refresh()}
        onApiReady={() => conn.refresh()}
        onReindexDoc={s.document.reindex}
        onPreferencesSaved={async () => {
          await prefs.refreshPrefs();
        }}
        includeViewingPageDefault={prefs.includeViewingPage}
        onIncludeViewingPageDefaultChange={(value) => void prefs.setIncludeViewingPageDefault(value)}
        followAgentDefault={prefs.followAgent}
        onFollowAgentDefaultChange={(value) => void prefs.setFollowAgentDefault(value)}
        onScanAllPages={requestScanAll}
        onTestResult={(message, ok) => showToast(message, ok ? "success" : "error")}
        onSaveError={() => showToast(t("settings.saveFailed"), "error")}
        onRefreshConnection={() => conn.refresh()}
      />

      {zen && doc && (
        <>
          {/* Reading progress, not scroll position. */}
          <div className="zen-progress" aria-hidden>
            <span
              className="zen-progress-fill"
              style={{ height: `${Math.round((s.document.page / Math.max(1, doc.totalPages)) * 100)}%` }}
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
        onOpenFile={s.library.openFileDialog}
        onSettings={overlays.openSettings}
        connected={conn.canUseAgent && conn.settingsReady}
        opening={loading}
      />

      <div className="v3-main">
        {!doc ? (
          <WelcomeView
            recentFiles={openableRecents}
            canUseAgent={conn.canUseAgent}
            hasApiKey={conn.hasApiKey}
            agentToolsSupported={conn.agentToolsSupported}
            opening={loading}
            onOpenFile={s.library.openFileDialog}
            onOpenRecent={s.library.openPath}
            onConfigureApi={overlays.openSettings}
          />
        ) : (
          <WorkspaceChromeProvider value={workspaceChrome}>
            <SearchScopeProvider value={searchScope}>
              <div className={`v3-workspace ${s.assistant.open ? "" : "agent-hidden"}`}>
                {/* The one header draws here (PreviewToolbar portals into it):
                    it spans both columns, which is what makes it one strip. */}
                <div className="workspace-header-slot" ref={setHeaderSlot} />
                <div className="v3-columns">
                  <Suspense fallback={<PanelFallback />}>
                    <PreviewPane
                      doc={doc}
                      page={s.document.page}
                      onPageChange={s.document.setPage}
                      prefsRevision={prefs.prefsRevision}
                      onOpenAiSettings={overlays.openSettings}
                      onAskAboutSelection={askAboutSelection}
                      selectedFindingId={revealedFindingId}
                      onSelectFinding={setRevealedFindingId}
                      selectedMarkId={selectedMarkId}
                      onSelectMark={setSelectedMarkId}
                      revealedCitation={revealedCitation}
                      citations={citedPages}
                      onRevealMessage={gotoMessage}
                    />
                  </Suspense>

                  {s.assistant.open && (
                    <ResizeHandle
                      onPointerDown={(e) => {
                        setPanelDragging(true);
                        s.assistant.shell.resize.onPointerDown(e);
                      }}
                      onNudge={s.assistant.shell.resize.nudgeWidth}
                      value={s.assistant.shell.resize.width}
                      min={s.assistant.shell.resize.min}
                      max={s.assistant.shell.resize.max}
                    />
                  )}
                  <div
                    className={`chat-column ${s.assistant.open ? "" : "chat-column-hidden"}${
                      panelDragging ? " chat-column-dragging" : ""
                    }`}
                    style={s.assistant.open ? { width: s.assistant.shell.resize.width } : undefined}
                    aria-hidden={!s.assistant.open}
                  >
                    <Suspense fallback={<PanelFallback />}>
                      <ChatPanel
                        ref={chatRef}
                        doc={doc}
                        page={s.document.page}
                        includeViewingPage={prefs.includeViewingPage}
                        agent={agent}
                        connection={conn}
                        session={{ loading, chatLoading: s.document.chatLoading }}
                        composerDraft={composerDraft}
                        onComposerDraftChange={setComposerDraft}
                        panel={{ tab: panelTab, setTab: setPanelTab, revision: recordRevision }}
                        reveal={{
                          onJumpToPage: s.document.setPage,
                          onRevealFinding: (id, target) => {
                            s.document.setPage(target);
                            setRevealedFindingId(id);
                          },
                          onRevealCitation: (target, rects) => {
                            s.document.setPage(target);
                            setRevealedCitation(rects ? { page: target, rects, nonce: Date.now() } : null);
                          },
                          onSelectMark: (target, id) => {
                            s.document.setPage(target);
                            setSelectedMarkId(id);
                          },
                        }}
                        scan={{ count: unscannedPages, onScanAllPages: requestScanAll }}
                        onConfigureApi={overlays.openSettings}
                      />
                    </Suspense>
                  </div>

                  {!s.assistant.open && (
                    <AgentDock
                      onExpand={() => s.assistant.setOpen(true)}
                      busy={agentBusy}
                      messageCount={agent.messages.list.length}
                    />
                  )}
                </div>
              </div>
            </SearchScopeProvider>
          </WorkspaceChromeProvider>
        )}
      </div>
    </div>
  );
}

function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  );
}

export default App;
