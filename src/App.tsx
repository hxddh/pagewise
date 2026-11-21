import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ToastProvider, useToast } from "./hooks/useToast";
import { subscribeStoreProblem, subscribeStoreUnreadable, subscribeWriteHealth } from "./lib/store-health";
import { useWorkbench } from "./session/useWorkbench";
import { useI18n } from "./i18n";
import { DropOverlay } from "./components/DropOverlay";
import { ResizeHandle } from "./components/ResizeHandle";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { ToastViewport } from "./components/ToastViewport";
import { Button } from "./components/ui/Button";
import { Input } from "./components/ui/Field";
import { Modal } from "./components/ui/Modal";
import { AppRail } from "./components/AppRail";
import { WelcomeView } from "./components/WelcomeView";
import { AgentDock } from "./components/AgentDock";
import { FileErrorBanner } from "./components/FileErrorBanner";
import { ConfirmDialog } from "./components/overlays/ConfirmDialog";
import { indexWholeDocument, pendingIndexPages } from "./document/index-queue";
import { ocrEnabled } from "./lib/ocr/ocr-service";
import { getVisionCallCount } from "./lib/usage-tracker";
import type { ExportAvailability, ExportChoice } from "./components/ExportDialog";
import { extractCitations, stripCitations } from "./lib/citations";
import { visibleText } from "./lib/conversation-search";
import { markdownToPlainText } from "./lib/markdown-text";
import { activeFindings, subscribeFindings } from "./lib/finding-store";
import { useAppCommands } from "./hooks/useAppCommands";
import { useFollowAgent } from "./hooks/useFollowAgent";
import { useWorkbenchOverlays } from "./hooks/useWorkbenchOverlays";
import { useTheme } from "./hooks/useTheme";
import { useWorkbenchPrefs } from "./hooks/useWorkbenchPrefs";
import { openableRecentFiles } from "./lib/recent-files";
import { getMarks, subscribeMarks } from "./lib/mark-store";
import { citationsByPage, answerNotesByPage } from "./lib/page-citations";
import { subscribeChecks, checksRevision } from "./lib/citation-check";
import { subscribeReviews, reviewRevision } from "./lib/claim-review";
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
const SettingsDrawer = lazy(() =>
  import("./components/SettingsDrawer").then((m) => ({ default: m.SettingsDrawer })),
);
const RecentFilesDrawer = lazy(() =>
  import("./components/RecentFilesDrawer").then((m) => ({ default: m.RecentFilesDrawer })),
);
const CommandPalette = lazy(() =>
  import("./components/CommandPalette").then((m) => ({ default: m.CommandPalette })),
);
const ExportDialog = lazy(() =>
  import("./components/ExportDialog").then((m) => ({ default: m.ExportDialog })),
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
    setMarginAskOpen(false);
    setMarginSessionActive(false);
    setDismissedMarginReplyId(null);
  }, [doc?.path]);

  useEffect(() => {
    setPasswordDraft("");
  }, [s.document.passwordPrompt.path]);

  // A store file the app could not read is the one failure the stores cannot
  // report through their return values — they answer a failed read the only way
  // they can, as "no data". Say it out loud instead, and say the one thing that
  // matters to the reader: the file was left exactly as it was (20.0).
  useEffect(
    () =>
      subscribeStoreUnreadable((store) =>
        showToast(t("toast.storeUnreadable", { file: store.file }), "error"),
      ),
    [showToast, t],
  );

  // A write a store held back on purpose: the file is a later version's, or
  // the record is full. Nothing on disk is lost; what the reader just did is
  // not saved, and that is the sentence they need (21.0).
  useEffect(
    () =>
      subscribeStoreProblem(({ file, problem }) =>
        showToast(
          t(problem === "newer" ? "toast.storeNewer" : "toast.storeFull", { file }),
          "error",
        ),
      ),
    [showToast, t],
  );

  // A write that failed outright — the conversation, the marks, the record.
  // Said once when a kind starts failing (store health dedupes the retries);
  // the header's "Not saved" carries it after the toast is gone (24.0).
  useEffect(
    () =>
      subscribeWriteHealth(({ kind, failed }) => {
        if (failed) showToast(t(`toast.writeFailed.${kind}`), "error");
      }),
    [showToast, t],
  );

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
    () =>
      doc
        ? (void recordRevision, activeFindings(doc.path).length + getMarks(doc.path).length)
        : 0,
    [doc, recordRevision],
  );

  const chatRef = useRef<ChatPanelHandle>(null);
  const [focusComposerNonce, setFocusComposerNonce] = useState(0);
  const [marginFocusNonce, setMarginFocusNonce] = useState(0);
  const [marginAskOpen, setMarginAskOpen] = useState(false);
  const [marginSessionActive, setMarginSessionActive] = useState(false);
  const [dismissedMarginReplyId, setDismissedMarginReplyId] = useState<string | null>(null);
  const [passwordDraft, setPasswordDraft] = useState("");
  const passwordInputRef = useRef<HTMLInputElement | null>(null);
  // Zen (18.0): the rail, the header and the panel leave; the page and a
  // progress hairline stay. Not persisted — a posture for this sitting.
  const [zen, setZen] = useState(false);
  const askAboutSelection = useCallback(
    (text: string) => {
      const insert = text.trim();
      if (!insert) return;
      setComposerDraft((prev) => (prev.trim() ? `${prev.trim()} ${insert} ` : `${insert} `));
      if (s.assistant.open) {
        setFocusComposerNonce((n) => n + 1);
      } else {
        setMarginAskOpen(true);
        setMarginFocusNonce((n) => n + 1);
      }
    },
    [s.assistant.open],
  );

  useEffect(() => {
    if (focusComposerNonce === 0) return;
    const id = requestAnimationFrame(() => requestAnimationFrame(() => chatRef.current?.focusComposer()));
    return () => cancelAnimationFrame(id);
  }, [focusComposerNonce]);

  const toggleZen = useCallback(() => {
    setZen((z) => {
      const next = !z;
      if (!next) setMarginAskOpen(false);
      return next;
    });
  }, []);
  /** The pill in Zen: open the floating margin ask bar in-place without leaving Zen. */
  const askFromZen = useCallback(() => {
    if (s.assistant.open) {
      s.assistant.setOpen(false);
    }
    setMarginAskOpen(true);
    setMarginFocusNonce((n) => n + 1);
  }, [s.assistant]);

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
      setZen(false);
      setPanelTab("chat");
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

  // The margin column's entries (20.0): every sentence of every answer that
  // cites a page, with the state its evidence put it in. Recomputed when a
  // check lands — the column has no chip of its own to re-render it — and when
  // a model review lands, since a review can lower a sentence's state.
  const checksRev = useSyncExternalStore(subscribeChecks, checksRevision);
  const reviewsRev = useSyncExternalStore(subscribeReviews, reviewRevision);
  const marginNotes = useMemo(
    () => (doc ? answerNotesByPage(doc.path, agent.messages.list) : null),
    // `checksRev` and `reviewsRev` are the subscription: they change exactly
    // when a check or a review lands and a state could have moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc?.path, agent.messages.list, checksRev, reviewsRev],
  );

  const marginReply = useMemo(() => {
    if (!doc || s.assistant.open || !marginSessionActive) return null;
    const list = agent.messages.list;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i]!;
      if (m.role !== "assistant") continue;
      if (m.id === dismissedMarginReplyId) return null;
      const raw = visibleText(m);
      if (!raw.trim()) return null;
      const hasCardOnViewingPage =
        marginNotes?.get(s.document.page)?.some((n) => n.messageId === m.id) ?? false;
      if (hasCardOnViewingPage) return null;
      const citedPages = [
        ...new Set(extractCitations(raw).flatMap((c) => c.pages)),
      ].filter((p) => p >= 1 && p <= doc.totalPages && p !== s.document.page);
      const text = markdownToPlainText(stripCitations(raw)).replace(/\s+/g, " ").trim();
      if (!text) return null;
      return { messageId: m.id, text, citedPages };
    }
    return null;
  }, [
    doc,
    s.assistant.open,
    marginSessionActive,
    agent.messages.list,
    dismissedMarginReplyId,
    marginNotes,
    s.document.page,
  ]);

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
      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette
            open={paletteOpen}
            commands={commands}
            onClose={() => setPaletteOpen(false)}
          />
        </Suspense>
      )}
      {exportAvailable !== null && (
        <Suspense fallback={null}>
          <ExportDialog
            open={exportAvailable !== null}
            available={exportAvailable}
            busy={agentBusy}
            onExport={runExport}
            onClose={() => setExportAvailable(null)}
          />
        </Suspense>
      )}
      <Modal
        open={s.document.passwordPrompt.path !== null}
        onClose={s.document.passwordPrompt.cancel}
        overlayClassName="palette-root"
        className="palette-panel export-panel"
        tone="elevated"
        ariaLabel={t("errors.pdfUnlockAction")}
        initialFocus={passwordInputRef}
      >
        <form
          className="password-unlock-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!passwordDraft) return;
            void s.document.passwordPrompt.unlock(passwordDraft);
          }}
        >
          <p className="password-unlock-prompt">{t("errors.pdfPasswordPrompt")}</p>
          <Input
            ref={passwordInputRef}
            type="password"
            size="md"
            value={passwordDraft}
            placeholder={t("errors.pdfPasswordPlaceholder")}
            aria-label={t("errors.pdfPasswordPlaceholder")}
            onChange={(e) => setPasswordDraft(e.target.value)}
          />
          {s.document.passwordPrompt.wrongPassword && (
            <p className="password-unlock-error" role="alert">
              {t("errors.pdfPasswordWrong")}
            </p>
          )}
          <div className="confirm-bar-actions">
            <Button
              type="button"
              variant="ghost"
              size="md"
              onClick={s.document.passwordPrompt.cancel}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={!passwordDraft || s.document.passwordPrompt.submitting}
            >
              {t("errors.pdfUnlockAction")}
            </Button>
          </div>
        </form>
      </Modal>
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

      {overlays.libraryOpen && (
        <Suspense fallback={null}>
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
        </Suspense>
      )}

      {s.assistant.shell.settingsOpen && (
        <Suspense fallback={null}>
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
            onSetupDone={() => {
              if (!s.document.doc) s.library.openFileDialog();
            }}
          />
        </Suspense>
      )}

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
          {!marginAskOpen && (
            <Button variant="secondary" size="lg" className="zen-ask" onClick={askFromZen}>
              {t("zen.ask")}
            </Button>
          )}
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
            onOpenSample={() => void s.library.openSample()}
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
                      notes={marginNotes}
                      marginColumn={!s.assistant.open}
                      marginAsk={{
                        visible:
                          !zen ||
                          marginAskOpen ||
                          agentBusy ||
                          Boolean(agent.run.errorMessage) ||
                          Boolean(marginReply),
                        draft: composerDraft,
                        busy: agentBusy,
                        progress: agent.run.progress,
                        errorMessage: agent.run.errorMessage,
                        onDismissError: agent.run.clearError,
                        reply: marginReply,
                        onDismissReply: marginReply
                          ? () => setDismissedMarginReplyId(marginReply.messageId)
                          : undefined,
                        focusNonce: marginFocusNonce,
                        onDraftChange: setComposerDraft,
                        onSubmit: (text) => {
                          setMarginSessionActive(true);
                          setDismissedMarginReplyId(null);
                          chatRef.current?.submitQuestion(text);
                        },
                        onStop: agent.run.stop,
                        onDismiss: zen ? () => setMarginAskOpen(false) : undefined,
                      }}
                      onRevealMessage={gotoMessage}
                      onReadRest={requestScanAll}
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
                          onRevealCitation: (target, rects, notice) => {
                            s.document.setPage(target);
                            setRevealedCitation(rects ? { page: target, rects, nonce: Date.now() } : null);
                            // Nothing lit: say why, in the chip's words (21.0).
                            if (notice) showToast(notice);
                          },
                          onSelectMark: (target, id) => {
                            s.document.setPage(target);
                            setSelectedMarkId(id);
                          },
                        }}
                        scan={{ count: unscannedPages, onScanAllPages: requestScanAll }}
                        onConfigureApi={overlays.openSettings}
                        settingsOpen={s.assistant.shell.settingsOpen}
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
