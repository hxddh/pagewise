import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatStatus, UIMessage } from "ai";
import { Globe, MoreHorizontal, PanelRightClose, X } from "lucide-react";
import { useI18n } from "../i18n";
import { AnchoredMenu } from "../components/AnchoredMenu";
import { MessageAssistantFooter } from "../components/MessageAssistantFooter";
import { MessageContent } from "../components/MessageContent";
import { useConversationKeys } from "../hooks/useConversationKeys";
import { reclaimUndeliveredNotes } from "../lib/agent-steer";
import { ConversationSearchBar } from "../components/ConversationSearchBar";
import { PageRefContext } from "../components/Markdown";
import type { PageWiseUIMessage } from "../lib/message-metadata";
import { EmptyState } from "../components/EmptyState";
import type { LoadedDocument } from "../lib/types";

import type { SendDocumentMessageOptions, RegenerateDocumentMessageOptions } from "../hooks/useDocAgent";
import {
  extractUserText,
  findLastMessage,
  getInFlightAssistantMessage,
  hasSubstantialAnswerText,
} from "../lib/messages-utils";
import { Button } from "../components/ui/Button";
import { followUpSuggestions } from "../lib/follow-ups";
import { collectReadPages } from "../lib/read-pages";
import { getMarks } from "../lib/mark-store";
import { usableOutline } from "../lib/outline-nav";
import { TextArea } from "../components/ui/Field";

export interface ChatPanelHandle {
  focusComposer: () => void;
}

interface ChatPanelProps {
  activeDoc: LoadedDocument | null;
  previewPage: number;
  includeViewingPage: boolean;
  messages: UIMessage[];
  sendDocumentMessage: (opts: SendDocumentMessageOptions) => Promise<boolean>;
  editUserMessage?: (messageId: string, opts: SendDocumentMessageOptions) => Promise<boolean>;
  regenerateDocumentMessage?: (opts: RegenerateDocumentMessageOptions) => Promise<boolean>;
  status: ChatStatus;
  error: Error | undefined;
  errorMessage?: string;
  hasApiKey: boolean;
  agentToolsSupported?: boolean;
  webSearchAvailable?: boolean;
  settingsReady: boolean;
  loadingDoc: boolean;
  chatLoading?: boolean;
  agentBusy?: boolean;
  activity: string | null;
  historySettling?: boolean;
  composerDraft: string;
  onComposerDraftChange: (value: string) => void;
  onConfigureApi: () => void;
  onStop: () => void;
  /** Stop whatever is running and resolve once the stream is idle. */
  waitForStreamIdle?: () => Promise<boolean>;
  /** Hand a correction to the run already going. False when it will not take one. */
  steerRun?: (text: string) => boolean;
  onDismissError?: () => void;
  onJumpToPage?: (page: number) => void;
  onClearChat: () => void;
  onExportChat: () => void;
  onExportSummary: () => void;
  onCollapse?: () => void;
  /** Pages in the active document that still have no text (each costs a scan). */
  unscannedPages?: number;
  /** Prompt to scan those pages; omit to hide the affordance entirely. */
  onScanAllPages?: () => void;
}

const COMPOSER_MAX_HEIGHT = 200;

export const ChatPanel = forwardRef<ChatPanelHandle, ChatPanelProps>(function ChatPanel(
  {
    activeDoc,
    previewPage,
    includeViewingPage,
    messages,
    sendDocumentMessage,
    editUserMessage,
    regenerateDocumentMessage,
    status,
    error,
    errorMessage,
    hasApiKey,
    agentToolsSupported = true,
    webSearchAvailable = false,
    settingsReady,
    loadingDoc,
    chatLoading = false,
    agentBusy = false,
    activity,
    historySettling = false,
    composerDraft,
    onComposerDraftChange,
    onConfigureApi,
    onStop,
    waitForStreamIdle,
    steerRun,
    onDismissError,
    onJumpToPage,
    onClearChat,
    onExportChat,
    onExportSummary,
    onCollapse,
    unscannedPages = 0,
    onScanAllPages,
  },
  ref,
) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  // Path of the document whose scan offer was dismissed. Keyed by path so
  // dismissing it for one document doesn't hide it for the next.
  const [scanHintDismissed, setScanHintDismissed] = useState<string | null>(null);
  const [webForNext, setWebForNext] = useState(false);
  // Bumped on every manual toggle click, so a failed send only re-arms the
  // web toggle if the user hasn't made a newer explicit choice mid-flight.
  const webToggleSeqRef = useRef(0);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    setEditingUserId(null);
    setEditDraft("");
    setEditError(null);
  }, [activeDoc?.path, chatLoading]);

  useImperativeHandle(ref, () => ({
    focusComposer: () => composerRef.current?.focus(),
  }));

  const busy = status === "streaming" || status === "submitted";
  const interactionBusy = busy || chatLoading || agentBusy;

  const lastAssistant = useMemo(
    () => findLastMessage(messages, (m) => m.role === "assistant"),
    [messages],
  );
  const inFlightAssistant = useMemo(
    () => getInFlightAssistantMessage(messages, busy),
    [messages, busy],
  );
  const lastUser = useMemo(
    () => findLastMessage(messages, (m) => m.role === "user"),
    [messages],
  );
  const showProgress = busy && !hasSubstantialAnswerText(inFlightAssistant);

  const followUps = useMemo(() => {
    if (busy || agentBusy || !activeDoc || activeDoc.kind !== "pdf") return [];
    if (!lastAssistant || lastAssistant.id === inFlightAssistant?.id) return [];
    return followUpSuggestions({
      readPages: collectReadPages(lastAssistant.parts),
      outline: usableOutline(activeDoc.outline, activeDoc.totalPages),
      totalPages: activeDoc.totalPages,
      unindexedCount: unscannedPages,
      markCount: getMarks(activeDoc.path).length,
      t,
    });
  }, [busy, agentBusy, activeDoc, lastAssistant, inFlightAssistant, unscannedPages, t]);

  const composerDraftRef = useRef(composerDraft);
  composerDraftRef.current = composerDraft;

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [composerDraft]);

  useEffect(() => {
    if (!stickToBottomRef.current || !messagesRef.current) return;
    messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [messages, status, activity]);

  /**
   * A correction that arrived too late goes back in the composer.
   *
   * A run can finish before the step that would have carried the note — the
   * reader typed while the last of the answer was already being written. The
   * alternative is to drop words they typed, so this hands them back the way a
   * failed send hands back its text, and they can send it as a question.
   */
  useEffect(() => {
    if (busy) return;
    const undelivered = reclaimUndeliveredNotes();
    if (undelivered.length === 0) return;
    if (composerDraftRef.current.trim()) return; // they have already typed something newer
    onComposerDraftChange(undelivered.join("\n"));
  }, [busy, onComposerDraftChange]);

  /**
   * Alt+Up / Alt+Down walk the conversation.
   *
   * The bare arrow keys belong to the composer — they move the caret — so this
   * takes a modifier, and it sits on the panel root rather than the message
   * list so it works while the composer has focus, which is where the caret
   * usually is. Focus moves to the message itself; the row is only
   * programmatically focusable, so Tab still goes straight to the composer.
   */
  const convKeys = useConversationKeys(messages, messagesRef, stickToBottomRef);

  const onMessagesScroll = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < 48;
  }, []);

  const submit = useCallback(async () => {
    const text = composerDraft.trim();
    if (!text) return;
    // Sending during a run steers it rather than being refused. Until 7.6 that
    // meant stopping the run and starting another — better than the disabled
    // composer it replaced, but its cost was understated by its own comment:
    // page text is free to re-read from the local cache, and is billed again as
    // tokens the moment it re-enters a fresh context. So the correction now goes
    // to the run that is already going, as a message its next step reads.
    //
    // The restart path survives for the cases injection cannot serve: no run to
    // inject into, or a run whose remaining steps have run out (below).
    const steering = busy && !chatLoading && !!waitForStreamIdle;
    if (interactionBusy && !steering) return;
    if (steering && !hasApiKey) {
      onConfigureApi();
      return;
    }
    if (steering && activeDoc && steerRun) {
      // steerRun both queues the note for the loop and records it on the user
      // turn that started the run — see useDocAgent. Queueing without recording
      // would clear the composer, change the answer, and leave no trace of why.
      if (steerRun(text)) {
        onComposerDraftChange("");
        stickToBottomRef.current = true;
        // Undelivered notes come back to the composer when the run settles —
        // see the effect below. Nothing else to do here: the run keeps going.
        return;
      }
      // The run has taken all the corrections it will (MAX_STEER_NOTES), so fall
      // through to the restart path rather than dropping what was typed.
    }
    // Only a missing API key is a hard blocker. Tool-capability is a heuristic
    // guess (looksLikeToolModel misses grok/kimi/glm/llama-4/nova and other
    // tool-capable routes) — don't pre-block the send on it; let the provider
    // surface the real error. Settings/EmptyState still show the capability
    // warning. Mirrors useDocAgent.prepareForAgentSend's own design intent.
    if (!hasApiKey) {
      onConfigureApi();
      return;
    }
    if (!activeDoc) return;
    if (steering) {
      const idle = await waitForStreamIdle();
      if (!idle) return;
    }
    stickToBottomRef.current = true;
    onComposerDraftChange("");
    const useWebSearch = webSearchAvailable && webForNext;
    const webToggleSeqAtSend = webToggleSeqRef.current;
    // Re-arm the failed send's web opt-in only if the user hasn't clicked the
    // toggle since — their newer explicit choice wins.
    const rearmWebToggle = () => {
      if (useWebSearch && webToggleSeqRef.current === webToggleSeqAtSend) {
        setWebForNext(true);
      }
    };
    try {
      const payload = {
        text,
        path: activeDoc.path,
        docName: activeDoc.name,
        docKind: activeDoc.kind,
        viewingPage: previewPage,
        totalPages: activeDoc.totalPages,
        includeViewingPage,
        webSearch: useWebSearch,
      };
      if (webForNext) setWebForNext(false);
      const sent = await sendDocumentMessage(payload);
      // Only restore the failed send's text if the user hasn't started a new
      // draft in the meantime — otherwise we'd clobber what they just typed.
      if (!sent) {
        rearmWebToggle();
        if (!composerDraftRef.current) onComposerDraftChange(text);
      }
    } catch {
      rearmWebToggle();
      if (!composerDraftRef.current) {
        onComposerDraftChange(text);
      }
    }
  }, [
    composerDraft,
    busy,
    chatLoading,
    waitForStreamIdle,
    steerRun,
    interactionBusy,
    hasApiKey,
    agentToolsSupported,
    activeDoc,
    previewPage,
    includeViewingPage,
    webSearchAvailable,
    webForNext,
    onConfigureApi,
    onComposerDraftChange,
    sendDocumentMessage,
  ]);

  // Read the viewing page / include-flag through refs: MessageAssistantFooter's
  // memo comparator intentionally ignores onRegenerate, so a footer already
  // rendered can hold an older handleRegenerate closure. Reading current values
  // from refs makes Regenerate use the page the user is actually on.
  const previewPageRef = useRef(previewPage);
  previewPageRef.current = previewPage;
  const includeViewingPageRef = useRef(includeViewingPage);
  includeViewingPageRef.current = includeViewingPage;
  // The error prop updates a render after the send rejects, so a failure handler
  // that reads `errorMessage` directly captures the pre-failure value. Read the
  // latest through a ref instead.
  const errorMessageRef = useRef(errorMessage);
  errorMessageRef.current = errorMessage;

  const handleRegenerate = useCallback(async () => {
    if (!activeDoc || !regenerateDocumentMessage || interactionBusy) return;
    // Tool-capability is a heuristic; only a missing key hard-blocks (see submit).
    if (!hasApiKey) {
      onConfigureApi();
      return;
    }
    stickToBottomRef.current = true;
    await regenerateDocumentMessage({
      path: activeDoc.path,
      docName: activeDoc.name,
      docKind: activeDoc.kind,
      viewingPage: previewPageRef.current,
      totalPages: activeDoc.totalPages,
      includeViewingPage: includeViewingPageRef.current,
    });
  }, [
    activeDoc,
    regenerateDocumentMessage,
    interactionBusy,
    hasApiKey,
    agentToolsSupported,
    onConfigureApi,
  ]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await submit();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Ignore Enter while an IME composition is active (critical for CJK input).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <PageRefContext.Provider value={onJumpToPage ?? null}>
    <div className="chat-panel" onKeyDown={convKeys.onKeyDown}>
      <header className="panel-header">
        <div className="panel-header-main">
          <h2>{t("agent.title")}</h2>
        </div>
        <div className="header-actions">
          {onCollapse && (
            <Button
              variant="ghost" size="md" icon
              onClick={onCollapse}
              title={t("agent.hidePanel")}
              aria-label={t("agent.hidePanel")}
            >
              <PanelRightClose size={16} />
            </Button>
          )}
          <Button
            ref={moreBtnRef}
            variant="ghost"
            size="md"
            icon
            aria-pressed={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            aria-label={t("agent.more")}
            title={messages.length === 0 ? t("agent.moreDisabledHint") : t("agent.more")}
            aria-expanded={menuOpen}
            disabled={messages.length === 0}
          >
            <MoreHorizontal size={16} />
          </Button>
          <AnchoredMenu
            open={menuOpen && messages.length > 0}
            onClose={() => setMenuOpen(false)}
            anchorRef={moreBtnRef}
            className="anchored-popover"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                void onExportChat();
              }}
              disabled={interactionBusy}
            >
              {t("agent.exportChat")}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                void onExportSummary();
              }}
              disabled={interactionBusy}
            >
              {t("agent.exportSummary")}
            </button>
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => {
                setMenuOpen(false);
                onClearChat();
              }}
              disabled={interactionBusy}
            >
              {t("agent.clear")}
            </button>
          </AnchoredMenu>
        </div>
      </header>

      {convKeys.searchOpen && <ConversationSearchBar keys={convKeys} />}

      <div className="messages messages-panel" ref={messagesRef} onScroll={onMessagesScroll}>
        {chatLoading && (
          <div className="chat-loading chat-loading-overlay" aria-live="polite">
            <span className="preview-loading-spinner" aria-hidden />
            {t("agent.loadingHistory")}
          </div>
        )}
        {!chatLoading && messages.length === 0 ? (
          <EmptyState
            hasApiKey={hasApiKey}
            agentToolsSupported={agentToolsSupported}
            settingsReady={settingsReady}
            hasDocument={!!activeDoc}
            totalPages={activeDoc?.totalPages}
            onConfigureApi={onConfigureApi}
            onExamplePrompt={(text) => {
              onComposerDraftChange(text);
              composerRef.current?.focus();
            }}
          />
        ) : (
          <>
            {messages.map((m) => (
              <div
                key={m.id}
                data-message-id={m.id}
                // Programmatically focusable only: keyboard navigation moves
                // focus here, but Tab must not walk every turn of a long
                // conversation on the way to the composer.
                tabIndex={-1}
                className={`message ${m.role}`}
              >
                {m.role === "assistant" ? (
                  <>
                    <MessageContent
                      message={m}
                      markdown
                      live={busy && m.id === inFlightAssistant?.id}
                      settling={historySettling && m.id === lastAssistant?.id && !busy}
                      activity={
                        busy && m.id === inFlightAssistant?.id && showProgress
                          ? (activity ?? t("agent.thinking"))
                          : null
                      }
                    />
                    <MessageAssistantFooter
                      message={m as PageWiseUIMessage}
                      live={busy && m.id === inFlightAssistant?.id}
                      canRegenerate={
                        !busy &&
                        m.id === lastAssistant?.id &&
                        !!lastUser &&
                        !!regenerateDocumentMessage
                      }
                      onRegenerate={() => void handleRegenerate()}
                    />
                  </>
                ) : editingUserId === m.id ? (
                  <form
                    className="message-edit-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!activeDoc || !editUserMessage || interactionBusy) return;
                      const text = editDraft.trim();
                      if (!text) return;
                      setEditError(null);
                      void editUserMessage(m.id, {
                        text,
                        path: activeDoc.path,
                        docName: activeDoc.name,
                        docKind: activeDoc.kind,
                        viewingPage: previewPage,
                        totalPages: activeDoc.totalPages,
                        includeViewingPage,
                      }).then((ok) => {
                        if (ok) {
                          setEditingUserId(null);
                          setEditError(null);
                        } else {
                          // The agent error state settles a render after the
                          // reject; read it next frame so we show the real
                          // provider message, not the generic fallback.
                          requestAnimationFrame(() =>
                            setEditError(errorMessageRef.current ?? t("agent.editFailed")),
                          );
                        }
                      });
                    }}
                  >
                    <TextArea
                      className="message-edit-input"
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      rows={3}
                      autoFocus
                    />
                    <div className="message-edit-actions">
                      <Button type="submit" variant="primary" size="md" disabled={interactionBusy}>
                        {t("agent.resend")}
                      </Button>
                      <Button
                        variant="secondary" size="sm"
                        onClick={() => {
                          setEditingUserId(null);
                          setEditError(null);
                        }}
                      >
                        {t("agent.cancelEdit")}
                      </Button>
                    </div>
                    {editError && (
                      <p className="message-edit-error" role="alert">
                        {editError}
                      </p>
                    )}
                  </form>
                ) : (
                  <>
                    <MessageContent message={m} />
                    {editUserMessage && !interactionBusy && m.id === lastUser?.id && (
                      <Button
                        variant="secondary" size="sm"
                        onClick={() => {
                          setEditingUserId(m.id);
                          setEditError(null);
                          setEditDraft(extractUserText(m));
                        }}
                      >
                        {t("agent.editMessage")}
                      </Button>
                    )}
                  </>
                )}
              </div>
            ))}
            {followUps.length > 0 && (
              // Derived from what the run did — the section after what it read,
              // the pages a search cannot reach, the passages the reader marked.
              // No second generation was paid for to produce these.
              <div className="follow-ups" aria-label={t("agent.followUpLabel")}>
                {followUps.map((f) => (
                  <Button
                    key={f.kind}
                    variant="secondary"
                    size="sm"
                    className="follow-up-chip"
                    onClick={() => {
                      onComposerDraftChange(f.text);
                      composerRef.current?.focus();
                    }}
                  >
                    {f.text}
                  </Button>
                ))}
              </div>
            )}
            {agentBusy && !inFlightAssistant && (
              <div className="message assistant message-in-progress" aria-live="polite">
                <p className="agent-generating-line message-inline-progress">
                  <span className="typing-dots" aria-hidden>
                    <span />
                    <span />
                    <span />
                  </span>
                  {activity ?? t("agent.thinking")}
                </p>
              </div>
            )}
          </>
        )}
      </div>

      {/*
        The agent can already tell that pages are unscanned (its tools report it)
        and the app can already fix it, but until now the only remedy was a
        command-palette entry the user had to know about. Offer it where the
        symptom shows up.
      */}
      {activeDoc &&
        onScanAllPages &&
        unscannedPages > 0 &&
        messages.length > 0 &&
        scanHintDismissed !== activeDoc.path && (
          <div className="error-line chat-error chat-scan-hint" role="status">
            <span className="chat-error-text">
              {t("agent.unscannedPages", { count: unscannedPages })}
            </span>
            <span className="chat-error-actions">
              <Button
                variant="secondary" size="sm"
                onClick={onScanAllPages}
                disabled={interactionBusy}
              >
                {t("preview.scanAllAction")}
              </Button>
              <Button
                variant="ghost" size="md" icon
                onClick={() => setScanHintDismissed(activeDoc.path)}
                aria-label={t("agent.dismissScanHint")}
                title={t("agent.dismissScanHint")}
              >
                <X size={14} />
              </Button>
            </span>
          </div>
        )}

      {error && (
        <div className="error-line chat-error" role="alert">
          <span className="chat-error-text">{errorMessage ?? error.message}</span>
          <span className="chat-error-actions">
            {regenerateDocumentMessage && (
              <Button
                variant="secondary" size="sm"
                onClick={() => void handleRegenerate()}
                disabled={interactionBusy || !activeDoc}
              >
                {t("agent.retry")}
              </Button>
            )}
            {onDismissError && (
              <Button
                variant="ghost" size="md" icon
                onClick={onDismissError}
                aria-label={t("agent.dismissError")}
                title={t("agent.dismissError")}
              >
                <X size={14} />
              </Button>
            )}
          </span>
        </div>
      )}

      <form className="composer" onSubmit={handleSubmit}>
        <TextArea
          ref={composerRef}
          value={composerDraft}
          onChange={(e) => onComposerDraftChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            busy
              ? t("agent.placeholderSteer")
              : activeDoc
                ? t("agent.placeholder")
                : t("agent.placeholderNoDoc")
          }
          rows={1}
          disabled={loadingDoc}
        />
        <div className="composer-footer">
          <span className="composer-hint">{t("agent.hint")}</span>
          {webSearchAvailable && !!activeDoc && (
            <Button
              variant="ghost"
              size="md"
              icon
              className="web-toggle"
              onClick={() => {
                webToggleSeqRef.current += 1;
                setWebForNext((v) => !v);
              }}
              aria-pressed={webForNext}
              title={webForNext ? t("agent.webSearchOn") : t("agent.webSearchOff")}
              aria-label={webForNext ? t("agent.webSearchOn") : t("agent.webSearchOff")}
            >
              <Globe size={15} />
            </Button>
          )}
          {(busy || agentBusy) && !composerDraft.trim() ? (
            <Button variant="secondary" size="md" onClick={onStop}>
              {t("agent.stop")}
            </Button>
          ) : busy && composerDraft.trim() ? (
            // Typing during a run turns Stop into Steer: the same key, and the
            // run it replaces keeps every page it already read.
            <Button type="submit" variant="primary" size="md" disabled={loadingDoc || !activeDoc}>
              {t("agent.steer")}
            </Button>
          ) : !!activeDoc && !hasApiKey ? (
            <Button
              variant="primary" size="md"
              onClick={onConfigureApi}
              disabled={loadingDoc}
            >
              {t("agent.configureApiCta")}
            </Button>
          ) : (
            <Button
              type="submit"
              variant="primary" size="md"
              disabled={!composerDraft.trim() || loadingDoc || !activeDoc}
            >
              {t("agent.send")}
            </Button>
          )}
        </div>
      </form>
    </div>
    </PageRefContext.Provider>
  );
});
